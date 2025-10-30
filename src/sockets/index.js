// src/sockets/index.js
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const chargingMonitor = require('../services/chargingMonitor');
const { normalizeSecret, getAllowedAlgs } = require('../utils/jwtHelpers');

let ioInstance = null;

const userRoom = (userId) => `user:${userId}`;

const setupSocketServer = (httpServer) => {
  ioInstance = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  chargingMonitor.attachIoServer(ioInstance);

  ioInstance.on('connection', (socket) => {
    // eslint-disable-next-line no-console
    console.log(`[socket.io] client connected: ${socket.id}`);
    let currentUserId = null;

    const authenticate = (rawToken) => {
      const secret = normalizeSecret(process.env.JWT_SECRET);
      if (!secret) {
        socket.emit('auth:error', { message: 'Server misconfigured' });
        return;
      }

      const token = typeof rawToken === 'string' ? rawToken : rawToken?.token;
      const normalized = String(token || '').trim();
      if (!normalized) {
        socket.emit('auth:error', { message: 'Token is required' });
        return;
      }

      try {
        const payload = jwt.verify(normalized, secret, {
          algorithms: getAllowedAlgs(),
          clockTolerance: 60,
        });

        if (!payload || typeof payload.id !== 'string' || !payload.id) {
          socket.emit('auth:error', { message: 'Token missing id claim' });
          return;
        }

        if (currentUserId) {
          socket.leave(userRoom(currentUserId));
        }

        currentUserId = payload.id;
        socket.join(userRoom(currentUserId));
        socket.emit('auth:success', { userId: currentUserId });
      } catch (error) {
        socket.emit('auth:error', { message: 'Authentication failed' });
      }
    };

    socket.on('auth:identify', authenticate);

    socket.on('notifications:subscribe', () => {
      if (currentUserId) {
        socket.join(userRoom(currentUserId));
      }
    });

    socket.on('notifications:unsubscribe', () => {
      if (currentUserId) {
        socket.leave(userRoom(currentUserId));
      }
    });

    socket.on('disconnect', () => {
      // eslint-disable-next-line no-console
      console.log(`[socket.io] client disconnected: ${socket.id}`);
      if (currentUserId) {
        socket.leave(userRoom(currentUserId));
        currentUserId = null;
      }
    });
  });

  return ioInstance;
};

const emitToUser = (userId, event, payload) => {
  if (!ioInstance || !userId) {
    return;
  }
  ioInstance.to(userRoom(userId)).emit(event, payload);
};

module.exports = {
  setupSocketServer,
  emitToUser,
  userRoom,
};
