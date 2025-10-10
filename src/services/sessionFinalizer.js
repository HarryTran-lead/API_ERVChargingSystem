const mongoose = require("mongoose");
const Session = require("../models/Session");
const Connector = require("../models/Connector");
const Booking = require("../models/Booking");
const { BOOKING_STATUS, SESSION_STATUS } = require("../constants/enums");
const bookingMonitor = require("./bookingMonitor");

const toNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const computeSocAtStop = (session, elapsedMinutes) => {
  const chargeDuration = toNumber(session.chargeDurationMinutes, 0);
  if (!chargeDuration) {
    return 100;
  }

  const socStart = toNumber(session.socStart, 0);
  const chargingMinutes = Math.min(elapsedMinutes, chargeDuration);
  const progress = Math.min(1, chargingMinutes / chargeDuration);
  const socDelta = (100 - socStart) * progress;

  return Math.min(100, Number((socStart + socDelta).toFixed(1)));
};

const normalizeStopTime = (session, stoppedAtInput) => {
  if (
    stoppedAtInput instanceof Date &&
    !Number.isNaN(stoppedAtInput.getTime())
  ) {
    return stoppedAtInput;
  }

  const stoppedAtCandidate = new Date(stoppedAtInput);
  if (!Number.isNaN(stoppedAtCandidate.getTime())) {
    return stoppedAtCandidate;
  }

  if (
    session.startedAt instanceof Date &&
    !Number.isNaN(session.startedAt.getTime())
  ) {
    const durationMinutes = toNumber(session.chargeDurationMinutes, 0);
    if (durationMinutes > 0) {
      return new Date(
        session.startedAt.getTime() + Math.round(durationMinutes * 60 * 1000)
      );
    }
  }

  return new Date();
};

async function completeSession(session, options = {}) {
  if (!session) {
    return null;
  }

  if (session.status !== SESSION_STATUS.CHARGING) {
    return session;
  }

  if (!session.startedAt) {
    throw new Error("Session start timestamp is missing");
  }

  const stoppedAt = normalizeStopTime(session, options.stoppedAt);
  const elapsedMinutes = Math.max(
    0,
    (stoppedAt.getTime() - session.startedAt.getTime()) / 60000
  );
  const socEnd = computeSocAtStop(session, elapsedMinutes);
  const chargeDuration = toNumber(session.chargeDurationMinutes, 0);
  const totalChargingMinutes = Math.min(elapsedMinutes, chargeDuration);
  const totalIdleMinutes = Math.max(0, elapsedMinutes - chargeDuration);
  const idleIntervalRaw = toNumber(session.idleFeeIntervalMinutes, 0);
  const idleFeeIntervalsApplied =
    idleIntervalRaw > 0 ? Math.floor(totalIdleMinutes / idleIntervalRaw) : 0;

  session.status = SESSION_STATUS.COMPLETED;
  session.socEnd = socEnd;
  session.stoppedAt = stoppedAt;
  session.totalChargingMinutes = Number(totalChargingMinutes.toFixed(1));
  session.totalIdleMinutes = Number(totalIdleMinutes.toFixed(1));
  session.idleFeeIntervalsApplied = idleFeeIntervalsApplied;

  await session.save();

  if (session.connectorId) {
    await Connector.findByIdAndUpdate(session.connectorId, { status: "IDLE" });
  }

  if (session.bookingId) {
    const updatedBooking = await Booking.findByIdAndUpdate(
      session.bookingId,
      { status: BOOKING_STATUS.COMPLETED },
      { new: true }
    );

    if (updatedBooking) {
      bookingMonitor.syncBooking(updatedBooking);
    }
  }

  return session;
}

const buildSessionLookup = (reference) => {
  if (!reference) {
    return null;
  }

  const query = { $or: [] };

  if (mongoose.Types.ObjectId.isValid(reference)) {
    query.$or.push({ _id: reference });
  }

  if (typeof reference === "string") {
    query.$or.push({ id: reference });
  }

  if (query.$or.length === 0) {
    return null;
  }

  return query;
};

async function completeSessionByReference(reference, options = {}) {
  const query = buildSessionLookup(reference);
  if (!query) {
    return null;
  }

  const session = await Session.findOne(query);
  if (!session) {
    return null;
  }

  if (session.status !== SESSION_STATUS.CHARGING) {
    return session;
  }

  return completeSession(session, options);
}

module.exports = {
  completeSession,
  completeSessionByReference,
};
