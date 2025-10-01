// src/models/PaymentSession.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const paymentSessionSchema = new mongoose.Schema({
  id: { type: String, default: uuidv4, unique: true },

  kind: { type: String, enum: ['TOPUP', 'SESSION'], required: true },
  user_id: { type: String, index: true, required: true },
  wallet_id: { type: String },

  // THÊM 'payos' vào enum
  provider: { type: String, enum: ['vnpay', 'momo', 'payos'], required: true },
  provider_order_id: { type: String, required: true, index: true },

  amount: { type: Number, required: true },
  method: { type: String },
  status: { type: String, enum: ['PENDING', 'SUCCEEDED', 'FAILED'], default: 'PENDING', index: true },
}, { timestamps: true });

paymentSessionSchema.index({ provider: 1, provider_order_id: 1 }, { unique: true });

module.exports = mongoose.model('PaymentSession', paymentSessionSchema);
