const { safeNotifyUser } = require('./notificationService');
const { formatToVietnamTime } = require('../utils/timezoneHelpers');

const formatDateForNotification = (value) =>
  value ? formatToVietnamTime(value) : null;

const toPlain = (doc) =>
  doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;

const notifyInvoiceChange = async (before, after) => {
  const previous = toPlain(before);
  const current = toPlain(after);

  if (!current?.user_id) {
    return;
  }

  const paymentChanged = previous?.payment_status !== current.payment_status;
  const statusChanged = previous?.status !== current.status;

  let title = 'Invoice updated';
  let body = `Invoice ${current.id} has been updated by an administrator.`;

  if (paymentChanged) {
    if (current.payment_status === 'PAID') {
      title = 'Invoice paid';
      body = `Invoice ${current.id} has been marked as paid on ${
        formatDateForNotification(current.paid_at) || 'the latest update'
      }.`;
    } else if (current.payment_status === 'EXPIRED') {
      title = 'Invoice expired';
      body = `Invoice ${current.id} is now marked as expired.`;
    } else if (current.payment_status === 'UNPAID') {
      title = 'Invoice payment pending';
      body = `Invoice ${current.id} has been set back to unpaid status.`;
    }
  } else if (statusChanged) {
    if (current.status === 'VOID') {
      title = 'Invoice voided';
      body = `Invoice ${current.id} has been voided by an administrator.`;
    } else if (current.status === 'ISSUED') {
      title = 'Invoice reissued';
      body = `Invoice ${current.id} has been reissued.`;
    }
  }

  await safeNotifyUser({
    userId: current.user_id,
    title,
    body,
    type: 'invoice',
    data: {
      invoiceId: current.id,
      status: current.status,
      paymentStatus: current.payment_status,
      total: current.total,
      paidTotal: current.paid_total,
      currency: current.currency,
      dueAt: formatDateForNotification(current.due_at),
      paidAt: formatDateForNotification(current.paid_at),
      sessionId: current.session_id,
    },
  });
};

module.exports = {
  notifyInvoiceChange,
};