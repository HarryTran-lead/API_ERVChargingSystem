const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')

const txSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true },
    wallet_id: { type: String, index: true },
    user_id: { type: String, index: true },
    type: { type: String, enum: ['TOPUP', 'DEBIT', 'REFUND'], required: true },
    amount: { type: Number, required: true, min: 1 }, // lưu dương; DEBIT/TYPE quyết định chiều
    method: { type: String },
    idempotency_key: { type: String, required: true },
    meta: { type: Object },
  },
  { timestamps: true }
)

// ✅ Khai báo index COMPOUND để chống nạp/trừ trùng theo user + key
txSchema.index({ user_id: 1, idempotency_key: 1 }, { unique: true })

module.exports = mongoose.model('WalletTransaction', txSchema)
