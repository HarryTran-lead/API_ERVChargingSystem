const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const userMembershipSchema = new mongoose.Schema({
  id: { type: String, default: uuidv4, unique: true },     // public id
  user_id: { type: String, required: true, unique: true, index: true }, // map với User.id (UUID)
  plan_code: { type: String, required: true, uppercase: true, index: true }, // FREE/BASIC/PRO
  status: { type: String, enum: ['ACTIVE', 'EXPIRED'], default: 'ACTIVE', index: true },

  // gia hạn đơn giản (chưa cần billing tự động)
  renew_at: { type: Date, default: null },

  // snapshot nhẹ để hiển thị (không bắt buộc)
  plan_name: { type: String, default: '' },
  monthly_fee_vnd: { type: Number, default: 0, min: 0 },

  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('UserMembership', userMembershipSchema);
