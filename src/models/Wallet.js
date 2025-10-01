// src/models/Wallet.js
const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')

// models/Wallet.js
const walletSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true },
    user_id: { type: String, ref: 'User', unique: true, index: true },
    // Tiền nên lưu ở đơn vị nhỏ nhất (vd: VND -> số nguyên)
    balance: { type: Number, default: 0},
  },
  {
    versionKey: false,
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  }
)
module.exports = mongoose.model('Wallet', walletSchema)
