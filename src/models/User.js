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
  status: { type: String, enum: ['ACTIVE', 'SUSPENDED'], default: 'ACTIVE' },
  created_at: { type: Date, default: Date.now }
})

module.exports = mongoose.model('User', userSchema)
