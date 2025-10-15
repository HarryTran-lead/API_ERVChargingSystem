// src/controllers/invoiceController.js
const mongoose = require("mongoose");
const Invoice = require("../models/Invoice");
const Wallet = require("../models/Wallet");
const WalletTx = require("../models/WalletTransaction");
const { ensureRequestUserId } = require("../utils/requestUser");

exports.getInvoice = async (req, res) => {
  const inv = await Invoice.findOne({ id: req.params.id });
  if (!inv) return res.status(404).json({ msg: "Invoice not found" });

  // Nếu là driver thì chỉ xem hóa đơn của mình
  if (req.user?.role === "driver" && inv.user_id !== req.user.id) {
    return res.status(403).json({ msg: "Forbidden" });
  }
  res.json(inv);
};

// GET /api/v1/invoices/me?status=UNPAID|PAID|EXPIRED
exports.listMyInvoices = async (req, res) => {
  const userId = ensureRequestUserId(req);
  const status = req.query.status;
  const q = { user_id: userId };
  if (status) q.payment_status = status;
  const invoices = await Invoice.find(q).sort({ createdAt: -1 }).lean();
  res.json({ items: invoices });
};

// POST /api/v1/invoices/:id/pay
exports.payInvoice = async (req, res) => {
  const userId = ensureRequestUserId(req);
  const inv = await Invoice.findOne({ id: req.params.id });
  if (!inv) return res.status(404).json({ msg: "Invoice not found" });
  if (inv.user_id !== userId && req.user?.role !== "admin") {
    return res.status(403).json({ msg: "Forbidden" });
  }
  if (inv.status !== "ISSUED") {
    return res.status(400).json({ msg: "Invoice is not payable (status)" });
  }
  if (inv.payment_status === "PAID") {
    return res.json({ ok: true, alreadyPaid: true, invoice: inv });
  }
  if (inv.due_at && new Date(inv.due_at).getTime() < Date.now()) {
    await Invoice.updateOne(
      { _id: inv._id },
      { $set: { payment_status: "EXPIRED" } }
    );
    return res.status(400).json({ msg: "Invoice is expired" });
  }

  // Idempotent debit by invoice
  const amount = Number(inv.total || 0);
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ msg: "Invalid invoice total" });
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const wallet = await Wallet.findOne({ user_id: inv.user_id }).session(
        session
      );
      if (!wallet) throw new Error("Wallet not found");

      const idemKey = `invoice:${inv.id}`;
      const existed = await WalletTx.findOne({
        user_id: inv.user_id,
        idempotency_key: idemKey,
      }).session(session);
      if (existed) {
        // Đã trừ trước đó: đánh dấu PAID nếu chưa cập nhật
        if (inv.payment_status !== "PAID") {
          await Invoice.updateOne(
            { _id: inv._id },
            {
              $set: {
                payment_status: "PAID",
                paid_total: amount,
                paid_at: new Date(),
              },
            }
          ).session(session);
        }
        return;
      }

      if ((wallet.balance || 0) < amount) {
        throw new Error("Insufficient wallet balance");
      }

      const [tx] = await WalletTx.create(
        [
          {
            wallet_id: wallet.id,
            user_id: inv.user_id,
            type: "DEBIT",
            amount,
            method: "wallet",
            idempotency_key: idemKey,
            status: "PENDING",
            meta: { invoice_id: inv.id },
          },
        ],
        { session }
      );

      const updated = await Wallet.findOneAndUpdate(
        { user_id: inv.user_id },
        { $inc: { balance: -amount } },
        { new: true, session }
      );

      await WalletTx.updateOne(
        { id: tx.id },
        { $set: { status: "SUCCEEDED", resulting_balance: updated.balance } },
        { session }
      );

      await Invoice.updateOne(
        { _id: inv._id },
        {
          $set: {
            payment_status: "PAID",
            paid_total: amount,
            paid_at: new Date(),
          },
        }
      ).session(session);
    });
  } finally {
    session.endSession();
  }

  const fresh = await Invoice.findOne({ id: inv.id });
  return res.json({ ok: true, invoice: fresh });
};
