// src/models/WalletTransaction.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const txSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true },
    wallet_id: { type: String, index: true, required: true },
    user_id:   { type: String, index: true, required: true },

    // HƯỚNG TIỀN: TOPUP(+), DEBIT(-), REFUND(+)
    type: { type: String, enum: ['TOPUP', 'DEBIT', 'REFUND'], required: true },

    // LUÔN LƯU DƯƠNG. Chiều tiền dựa vào 'type'
    amount: { type: Number, required: true, min: 1 },

    // Phân loại nghiệp vụ (tự do nhưng nên chuẩn hoá enum như dưới)
    category: { 
      type: String,
      enum: ['SUBSCRIPTION', 'CHARGE', 'IDLE_FEE', 'ADJUSTMENT', 'OTHER'],
      default: 'OTHER'
    },

    method: { type: String, default: 'wallet' }, // 'wallet' | 'payos' | ...
    idempotency_key: { type: String, required: true },
    status: { type: String, enum: ['PENDING','SUCCEEDED','FAILED'], default: 'SUCCEEDED' },

    resulting_balance: { type: Number }, // số dư sau giao dịch
    meta: { type: Object },
  },
  { timestamps: true }
);

// Chống double-charge
txSchema.index({ user_id: 1, idempotency_key: 1 }, { unique: true });

module.exports = mongoose.model('WalletTransaction', txSchema);
