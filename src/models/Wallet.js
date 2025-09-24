// src/models/Wallet.js
const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')

const walletSchema = new mongoose.Schema({
  id: { type: String, default: uuidv4, unique: true },
  user_id: { type: String, ref: 'User', unique: true },
  balance: { type: Number, default: 0 },
  updated_at: { type: Date, default: Date.now }
})

module.exports = mongoose.model('Wallet', walletSchema)
