const Booking = require("../models/Booking");
const { BOOKING_STATUS } = require("../constants/enums");
const { autoCancelBooking, schedulerEvents } = require("./bookingScheduler");

const TICK_INTERVAL_MS = 1000;

let ioServer = null;
const trackedBookings = new Map();

const normalizeId = (value) => {
  if (!value) return null;
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (typeof value === "object" && value !== null) {
    if (typeof value.toString === "function") {
      const str = value.toString();
      return str && str !== "[object Object]" ? str : null;
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
};

const toPlainBooking = (booking) => {
  if (!booking) return null;
  if (typeof booking.toObject === "function") {
    return booking.toObject();
  }
  if (booking._doc) {
    return { ...booking._doc };
  }
  return { ...booking };
};

const parseDate = (input) => {
  if (!input) return null;
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input;
  }
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const computeRemainingSeconds = (deadline) => {
  if (!deadline) return null;
  const diff = deadline.getTime() - Date.now();
  if (diff <= 0) {
    return 0;
  }
  return Math.round(diff / 1000);
};

const buildSnapshot = (booking) => {
  const plain = toPlainBooking(booking);
  if (!plain) return null;

  const bookingId =
    normalizeId(plain._id) ||
    normalizeId(plain.bookingId) ||
    normalizeId(plain.id);
  if (!bookingId) {
    return null;
  }

  const slotStart = parseDate(plain.slotStart);
  const slotEnd = parseDate(plain.slotEnd);
  const checkInDeadline = parseDate(plain.checkInDeadline);
  const remainingSeconds = computeRemainingSeconds(checkInDeadline);

  return {
    bookingId,
    bookingRef: plain.id || null,
    status: plain.status,
    slotStart,
    slotEnd,
    checkInDeadline,
    connectorId: normalizeId(plain.connectorId),
    stationId: normalizeId(plain.stationId),
    userId: plain.userId ? normalizeId(plain.userId) : null,
    remainingSeconds,
    isLate: checkInDeadline ? checkInDeadline.getTime() <= Date.now() : false,
    updatedAt: parseDate(plain.updatedAt) || new Date(),
  };
};

const emitSnapshot = (bookingId) => {
  if (!ioServer) return;
  const entry = trackedBookings.get(bookingId);
  if (!entry || !entry.snapshot) return;
  ioServer.to(roomName(bookingId)).emit("booking:update", entry.snapshot);
};

const tickBooking = (bookingId) => {
  const entry = trackedBookings.get(bookingId);
  if (!entry || !entry.snapshot) {
    return;
  }

  const deadline = entry.snapshot.checkInDeadline
    ? parseDate(entry.snapshot.checkInDeadline)
    : null;

  let remainingSeconds = null;
  let isLate = false;
  if (deadline) {
    const diff = deadline.getTime() - Date.now();
    remainingSeconds = diff > 0 ? Math.round(diff / 1000) : 0;
    isLate = diff <= 0;
  }

  entry.snapshot = {
    ...entry.snapshot,
    remainingSeconds,
    isLate,
    lastTickAt: new Date(),
  };

  emitSnapshot(bookingId);

  if (
    entry.snapshot.status === BOOKING_STATUS.RESERVED &&
    isLate &&
    !entry.autoCancelling
  ) {
    entry.autoCancelling = true;
    autoCancelBooking(bookingId)
      .then((updatedBooking) => {
        entry.autoCancelling = false;
        if (updatedBooking) {
          syncBooking(updatedBooking);
        } else {
          const snapshot = trackedBookings.get(bookingId)?.snapshot;
          if (snapshot && snapshot.status !== BOOKING_STATUS.RESERVED) {
            emitSnapshot(bookingId);
          }
        }
      })
      .catch((err) => {
        entry.autoCancelling = false;
        // eslint-disable-next-line no-console
        console.error(
          "[bookingMonitor] Failed to auto-cancel booking",
          bookingId,
          err
        );
      });
  }
};

const ensureTimer = (bookingId, entry, shouldTrack) => {
  if (shouldTrack) {
    if (!entry.timer) {
      entry.timer = setInterval(() => tickBooking(bookingId), TICK_INTERVAL_MS);
    }
  } else if (entry.timer) {
    clearInterval(entry.timer);
    entry.timer = null;
    entry.autoCancelling = false;
  }
};

function syncBooking(booking) {
  const snapshot = buildSnapshot(booking);
  if (!snapshot) {
    return null;
  }

  const bookingId = snapshot.bookingId;
  let entry = trackedBookings.get(bookingId);
  if (!entry) {
    entry = { snapshot, timer: null, autoCancelling: false };
    trackedBookings.set(bookingId, entry);
  } else {
    entry.snapshot = { ...entry.snapshot, ...snapshot };
  }

  const shouldTrack = snapshot.status === BOOKING_STATUS.RESERVED;
  ensureTimer(bookingId, entry, shouldTrack);

  emitSnapshot(bookingId);

  return entry.snapshot;
}

const stopTracking = (bookingId) => {
  const entry = trackedBookings.get(bookingId);
  if (!entry) return;
  if (entry.timer) {
    clearInterval(entry.timer);
  }
  trackedBookings.delete(bookingId);
};

const roomName = (bookingId) => `booking:${bookingId}`;

const getSnapshot = (bookingId) => {
  const entry = trackedBookings.get(normalizeId(bookingId));
  return entry ? entry.snapshot : null;
};

const attachIoServer = (io) => {
  ioServer = io;
};

const ensureTrackingLoaded = async (bookingId) => {
  const id = normalizeId(bookingId);
  if (!id) return null;
  const existing = trackedBookings.get(id);
  if (existing?.snapshot) {
    return existing.snapshot;
  }

  const booking = await Booking.findById(id).lean();
  if (!booking) {
    return null;
  }

  return syncBooking(booking);
};

schedulerEvents.on("autoCancelled", (booking) => {
  if (!booking) return;
  syncBooking(booking);
});

module.exports = {
  attachIoServer,
  syncBooking,
  stopTracking,
  getSnapshot,
  roomName,
  ensureTrackingLoaded,
};
