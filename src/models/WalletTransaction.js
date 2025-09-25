const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')

// models/WalletTransaction.js
const txSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true },
    wallet_id: { type: String, index: true },
    user_id: { type: String, index: true },
    type: { type: String, enum: ['TOPUP', 'DEBIT', 'REFUND'], required: true },
    amount: { type: Number, required: true, min: 1 }, // số nguyên
    method: { type: String },                         // 'bank', 'momo', ...
    // Chống nạp trùng (idempotency): unique kết hợp theo nguồn
    idempotency_key: { type: String, index: true, unique: true },
    meta: { type: Object },
  },
  { timestamps: true }
)
module.exports = mongoose.model('WalletTransaction', txSchema)
