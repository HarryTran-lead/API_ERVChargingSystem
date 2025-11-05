const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const OnsitePaymentSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true },
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Invoice',
      required: true,
      index: true,
    },
    invoiceRef: { type: String, required: true, index: true },
    sessionRef: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    staffId: { type: String, required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'VND' },
    method: { type: String, default: 'CASH', trim: true },
    note: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

OnsitePaymentSchema.index({ invoiceRef: 1 }, { unique: true });
OnsitePaymentSchema.index({ sessionRef: 1 }, { unique: true });

module.exports = mongoose.model('OnsitePayment', OnsitePaymentSchema);