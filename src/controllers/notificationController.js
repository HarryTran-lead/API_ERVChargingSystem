const asyncHandler = require('../utils/asyncHandler');
const Notification = require('../models/Notification');
const { HttpError } = require('../utils/errors');
const { ensureRequestUserId } = require('../utils/requestUser');
const { formatNotification } = require('../services/notificationService');

const parsePagination = (rawPage, rawLimit) => {
  const page = Math.max(1, Number(rawPage) || 1);
  const limit = Math.min(100, Math.max(1, Number(rawLimit) || 20));
  return { page, limit };
};

exports.listMyNotifications = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const { page: rawPage, limit: rawLimit, unread } = req.query;
  const { page, limit } = parsePagination(rawPage, rawLimit);
  const skip = (page - 1) * limit;

  const filters = { userId };
  if (typeof unread !== 'undefined') {
    const normalized = String(unread).toLowerCase();
    if (['true', '1'].includes(normalized)) {
      filters.readAt = null;
    } else if (['false', '0'].includes(normalized)) {
      filters.readAt = { $ne: null };
    }
  }

  const [items, total, unreadCount] = await Promise.all([
    Notification.find(filters)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Notification.countDocuments(filters),
    Notification.countDocuments({ userId, readAt: null }),
  ]);

  res.json({
    pagination: {
      page,
      limit,
      total,
      pages: limit > 0 ? Math.ceil(total / limit) : 0,
    },
    unreadCount,
    notifications: items.map((item) => formatNotification(item)),
  });
});

exports.markNotificationRead = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const { id } = req.params;
  if (!id) {
    throw new HttpError(400, 'Notification id is required');
  }

  const notification = await Notification.findOneAndUpdate(
    { userId, $or: [{ id }, { _id: id }] },
    { $set: { readAt: new Date() } },
    { new: true }
  );

  if (!notification) {
    throw new HttpError(404, 'Notification not found');
  }

  res.json({ notification: formatNotification(notification) });
});

exports.markAllNotificationsRead = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const now = new Date();
  const result = await Notification.updateMany(
    { userId, readAt: null },
    { $set: { readAt: now } }
  );

  const unreadCount = await Notification.countDocuments({ userId, readAt: null });

  res.json({
    updated: result.modifiedCount || 0,
    unreadCount,
  });
});