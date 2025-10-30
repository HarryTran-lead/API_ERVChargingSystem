const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const NotificationSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true },
    userId: { type: String, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, trim: true },
    type: {
      type: String,
      enum: ['info', 'success', 'warning', 'error', 'booking', 'session', 'invoice', 'wallet', 'system'],
      default: 'info',
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

NotificationSchema.virtual('isRead').get(function getIsRead() {
  return Boolean(this.readAt);
});

NotificationSchema.set('toJSON', { virtuals: true });
NotificationSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Notification', NotificationSchema);