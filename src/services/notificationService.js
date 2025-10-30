const Notification = require('../models/Notification');
const { emitToUser } = require('../sockets');

const toPlain = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject() : doc);

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

const notifyUser = async ({ userId, title, body = '', type = 'info', data = {} }) => {
  if (!userId || !title) {
    throw new Error('userId and title are required to create a notification');
  }

  const notification = await Notification.create({
    userId,
    title,
    body,
    type,
    data,
  });

  const shaped = formatNotification(notification);
  emitNotification(userId, shaped);
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