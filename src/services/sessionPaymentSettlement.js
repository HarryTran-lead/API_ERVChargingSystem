const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const Invoice = require('../models/Invoice');
const { PAYMENT_METHODS } = require('../constants/enums');
const { notifyInvoiceChange } = require('./invoiceNotifier');

const toPlain = (doc) =>
  doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;

async function settleSessionPayment(sessionDoc) {
  const session = toPlain(sessionDoc);
  if (!session) {
    return { status: 'SKIPPED', reason: 'NO_SESSION' };
  }

  if (session.paymentMethod !== PAYMENT_METHODS.WALLET) {
    return { status: 'SKIPPED', reason: 'NON_WALLET_METHOD' };
  }

  const total = Number(session.billing?.totalAmount || 0);
  if (!Number.isFinite(total) || total <= 0) {
    return { status: 'SKIPPED', reason: 'NO_CHARGE' };
  }

  const mongoSession = await Wallet.startSession();
  const outcome = { status: 'SKIPPED' };
  let invoiceBefore = null;
  let invoiceAfter = null;

  try {
    await mongoSession.withTransaction(async () => {
      const wallet = await Wallet.findOne({ user_id: session.userId }).session(
        mongoSession
      );

      if (!wallet) {
        outcome.status = 'FAILED';
        outcome.reason = 'WALLET_NOT_FOUND';
        return;
      }

      const invoice = await Invoice.findOne({
        session_id: session.id,
      }).session(mongoSession);

      if (!invoice) {
        outcome.status = 'FAILED';
        outcome.reason = 'INVOICE_NOT_FOUND';
        return;
      }

      invoiceBefore = invoice.toObject();

      if (wallet.balance < total) {
        outcome.status = 'FAILED';
        outcome.reason = 'INSUFFICIENT_FUNDS';
        invoice.meta = {
          ...(invoice.meta || {}),
          walletSettlement: {
            status: 'FAILED',
            reason: 'INSUFFICIENT_FUNDS',
            attemptedAt: new Date(),
            walletBalance: wallet.balance,
            sessionId: session.id,
          },
        };
        await invoice.save({ session: mongoSession });
        invoiceAfter = invoice.toObject();
        return;
      }

      const idempotencyKey = `charge:session:${session.id}`;

      let tx = await WalletTransaction.findOne({
        user_id: session.userId,
        idempotency_key: idempotencyKey,
      }).session(mongoSession);

      if (!tx) {
        const [created] = await WalletTransaction.create(
          [
            {
              wallet_id: wallet.id,
              user_id: session.userId,
              type: 'DEBIT',
              amount: total,
              category: 'CHARGE',
              method: 'wallet',
              idempotency_key: idempotencyKey,
              status: 'SUCCEEDED',
              meta: {
                sessionId: session.id,
                bookingRef: session.bookingRef || null,
                invoiceId: invoice.id,
                chargingAmount: session.billing?.chargingAmount || 0,
                idleAmount: session.billing?.idleAmount || 0,
              },
            },
          ],
          { session: mongoSession }
        );

        tx = created;

        const updatedWallet = await Wallet.findOneAndUpdate(
          { user_id: session.userId },
          { $inc: { balance: -total } },
          { new: true, session: mongoSession }
        );

        tx.resulting_balance = updatedWallet.balance;
        await tx.save({ session: mongoSession });

        invoice.payment_status = 'PAID';
        invoice.paid_at = new Date();
        invoice.paid_total = total;
        invoice.meta = {
          ...(invoice.meta || {}),
          walletSettlement: {
            status: 'PAID',
            chargedAt: invoice.paid_at,
            sessionId: session.id,
            transactionId: tx.id,
            amount: total,
          },
        };
        await invoice.save({ session: mongoSession });
      }

      outcome.status = 'PAID';
      outcome.walletTransaction = toPlain(tx);
      invoiceAfter = invoice.toObject();
    });
  } finally {
    await mongoSession.endSession();
  }

  if (invoiceBefore && invoiceAfter) {
    await notifyInvoiceChange(invoiceBefore, invoiceAfter);
  }

  if (invoiceAfter && !outcome.invoice) {
    outcome.invoice = invoiceAfter;
  }

  return outcome;
}

module.exports = {
  settleSessionPayment,
};