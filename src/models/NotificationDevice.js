const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const NotificationDeviceSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true },
    userId: { type: String, required: true, index: true },
    token: { type: String, required: true, unique: true },
    platform: { type: String, enum: ['ios', 'android', 'web', 'unknown'], default: 'unknown' },
    deviceId: { type: String, default: null },
    enabled: { type: Boolean, default: true },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('NotificationDevice', NotificationDeviceSchema);