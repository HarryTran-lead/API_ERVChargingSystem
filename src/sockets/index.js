const { Server } = require("socket.io");
const chargingMonitor = require("../services/chargingMonitor");

const setupSocketServer = (httpServer) => {
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  chargingMonitor.attachIoServer(io);

  io.on("connection", (socket) => {
    // eslint-disable-next-line no-console
    console.log(`[socket.io] client connected: ${socket.id}`);

    socket.on("charging:subscribe", (sessionId) => {
      const id = sessionId?.toString?.().trim();
      if (!id) {
        return;
      }

      socket.join(chargingMonitor.roomName(id));
      const snapshot = chargingMonitor.getSnapshot(id);
      if (snapshot) {
        socket.emit("charging:update", snapshot);
      }
    });

    socket.on("charging:unsubscribe", (sessionId) => {
      const id = sessionId?.toString?.().trim();
      if (!id) {
        return;
      }
      socket.leave(chargingMonitor.roomName(id));
    });

    socket.on("disconnect", () => {
      // eslint-disable-next-line no-console
      console.log(`[socket.io] client disconnected: ${socket.id}`);
    });
  });

  return io;
};

module.exports = { setupSocketServer };
