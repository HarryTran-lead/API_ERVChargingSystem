// src/services/notificationService.js
const Notification = require('../models/Notification');
const NotificationDevice = require('../models/NotificationDevice');
const User = require('../models/User');
const { emitToUser } = require('../sockets');
const { getMessaging } = require('../providers/firebase');

const toPlain = (doc) =>
  doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;

const formatNotification = (doc) => {
  if (!doc) {
    return null;
  }

  const payload = toPlain(doc);

  return {
    id: payload.id,
    userId: payload.userId,
    title: payload.title,
    body: payload.body || '',
    type: payload.type || 'info',
    data: payload.data || {},
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    readAt: payload.readAt || null,
    isRead: Boolean(payload.readAt),
  };
};

const emitNotification = (userId, notification) => {
  if (!userId || !notification) {
    return;
  }

  emitToUser(userId, 'notifications:new', notification);
};

const getNotificationCategory = (type = '') => {
  const normalized = String(type).toLowerCase();

  if (['booking', 'booking.request', 'booking.status'].includes(normalized)) {
    return 'booking';
  }
  if (['session', 'session.status', 'session.alert'].includes(normalized)) {
    return 'session';
  }
  if (['invoice', 'invoice.payment', 'wallet'].includes(normalized)) {
    return 'invoice';
  }
  if (['marketing', 'promotion'].includes(normalized)) {
    return 'marketing';
  }

  return null;
};

const shouldSendPush = (preferences = {}, type = '') => {
  if (!preferences.pushEnabled) return false;

  const category = getNotificationCategory(type);
  if (!category) return true;

  const categories = preferences.categories || {};
  if (typeof categories[category] === 'boolean') {
    return categories[category];
  }

  return true;
};

const buildDataPayload = (notification) => {
  const payload = {
    notificationId: notification.id,
    type: notification.type || 'info',
  };

  const data = notification.data || {};
  Object.entries(data).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    // FCM data phải là string
    payload[key] =
      typeof value === 'object' ? JSON.stringify(value) : String(value);
  });

  return payload;
};

const sendPushNotification = async (notification) => {
  const messaging = getMessaging();
  if (!messaging) return;

  const user = await User.findOne({ id: notification.userId }).select(
    'notification_preferences',
  );
  if (!user) return;

  if (
    !shouldSendPush(
      user.notification_preferences || {},
      notification.type,
    )
  ) {
    return;
  }

  const devices = await NotificationDevice.find({
    userId: notification.userId,
    enabled: true,
  })
    .select('token')
    .lean();

  const tokens = Array.from(
    new Set(
      devices
        .map((device) => device.token)
        .filter(Boolean),
    ),
  );

  if (tokens.length === 0) return;

  const message = {
    tokens,
    notification: {
      title: notification.title,
      body: notification.body || '',
    },
    data: buildDataPayload(notification),
  };

  try {
    await messaging.sendEachForMulticast(message);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[notification] Failed to send push notification', {
      error: error.message,
      userId: notification.userId,
      notificationId: notification.id,
    });
  }
};

const notifyUser = async ({
  userId,
  title,
  body = '',
  type = 'info',
  data = {},
}) => {
  if (!userId || !title) {
    throw new Error(
      'userId and title are required to create a notification',
    );
  }

  const notification = await Notification.create({
    userId,
    title,
    body,
    type,
    data,
  });

  const shaped = formatNotification(notification);

  // Giữ hành vi cũ: emit qua socket
  emitNotification(userId, shaped);

  // Thêm hành vi mới: gửi push nếu có device + cho phép
  await sendPushNotification(shaped);

  return shaped;
};

const safeNotifyUser = async (payload) => {
  try {
    return await notifyUser(payload);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[notification] Failed to send notification', {
      error: error.message,
      userId: payload?.userId,
      title: payload?.title,
    });
    return null;
  }
};

module.exports = {
  formatNotification,
  notifyUser,
  safeNotifyUser,
};
