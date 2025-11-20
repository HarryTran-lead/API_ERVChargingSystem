// src/models/User.js
const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')

const userSchema = new mongoose.Schema({
  id: { type: String, default: uuidv4, unique: true },
  name: { type: String, required: true, minlength: 1, maxlength: 100 },
  email: { type: String, required: true, unique: true, match: /.+@.+\..+/ },
  phone: { type: String, unique: true, sparse: true },
  password_hash: { type: String, required: true },
  role: {
    type: String,
    enum: ['driver', 'staff', 'admin'],
    default: 'driver'
  },
    stationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Station',
    index: true
  },
  status: { type: String, enum: ['ACTIVE', 'SUSPENDED'], default: 'ACTIVE' },
  password_reset_token: { type: String, default: null },
  password_reset_expires: { type: Date, default: null },
  password_changed_at: { type: Date, default: null },
  notification_preferences: {
    pushEnabled: { type: Boolean, default: true },
    emailEnabled: { type: Boolean, default: true },
    smsEnabled: { type: Boolean, default: false },
    categories: {
      booking: { type: Boolean, default: true },
      session: { type: Boolean, default: true },
      invoice: { type: Boolean, default: true },
      marketing: { type: Boolean, default: false },
    },
  },
  created_at: { type: Date, default: Date.now }
})

module.exports = mongoose.model('User', userSchema)
