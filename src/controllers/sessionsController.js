const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Connector = require("../models/Connector");
const Vehicle = require("../models/Vehicle");
const Session = require("../models/Session");
const Wallet = require("../models/Wallet");
const asyncHandler = require("../utils/asyncHandler");
const { HttpError } = require("../utils/errors");
const { ensureRequestUserId } = require("../utils/requestUser");
const { BOOKING_STATUS, SESSION_STATUS } = require("../constants/enums");
const {
  BOOKING_SLOT_MINUTES,
  SESSION_MIN_BALANCE_BASE_VND,
  SESSION_SOC_RANDOM_MIN,
  SESSION_SOC_RANDOM_MAX,
  SESSION_IDLE_FEE_INTERVAL_MINUTES,
} = require("../constants/business");
const { cancelNoShowJob } = require("../services/bookingScheduler");
const {
  startSessionBroadcast,
  finalizeSessionBroadcast,
} = require("../services/chargingMonitor");
const bookingMonitor = require("../services/bookingMonitor");
const { completeSession } = require("../services/sessionFinalizer");
const randomIntInclusive = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const buildBookingQuery = (userId, reference) => {
  const query = {
    userId,
    $or: [{ id: reference }],
  };

  if (mongoose.Types.ObjectId.isValid(reference)) {
    query.$or.push({ _id: reference });
  }

  return query;
};

const buildSessionQuery = (userId, reference) => {
  const query = {
    userId,
    $or: [{ id: reference }],
  };

  if (mongoose.Types.ObjectId.isValid(reference)) {
    query.$or.push({ _id: reference });
  }

  return query;
};

const resolveConfiguredChargeDurationMinutes = () => {
  const raw = process.env.SESSION_CHARGE_DURATION_MINUTES;
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
};

const computeChargeDurationMinutes = () => {
  const configured = resolveConfiguredChargeDurationMinutes();
  const maxMinutes = BOOKING_SLOT_MINUTES;
  

  if (configured) {
    return Math.min(maxMinutes, Math.round(configured));
  }

   return maxMinutes;
};

// const computeSocAtStop = (session, elapsedMinutes) => {
//   if (!session.chargeDurationMinutes || session.chargeDurationMinutes <= 0) {
//     return 100;
//   }

//   const chargingMinutes = Math.min(
//     elapsedMinutes,
//     session.chargeDurationMinutes
//   );

//   const progress = Math.min(1, chargingMinutes / session.chargeDurationMinutes);

//   const socDelta = (100 - session.socStart) * progress;
//   return Math.min(100, Number((session.socStart + socDelta).toFixed(1)));
// };

const toPlainSession = (session) =>
  typeof session.toObject === "function" ? session.toObject() : session;

const formatSessionPayload = (sessionDoc) => {
  const session = toPlainSession(sessionDoc);

  return {
    _id: session._id?.toString(),
    id: session.id,
    bookingId: session.bookingRef || session.bookingId?.toString(),
    connectorId: session.connectorId?.toString(),
    status: session.status,
    socStart: session.socStart,
    socEnd: session.socEnd,
    socTarget: session.socTarget,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    expectedFullAt: session.expectedFullAt,
    slotEnd: session.slotEnd,
    idleFeeNoticeAt: session.idleFeeNoticeAt,
    chargeDurationMinutes: session.chargeDurationMinutes,
    idleFeeIntervalMinutes: session.idleFeeIntervalMinutes,
    totalChargingMinutes: session.totalChargingMinutes,
    totalIdleMinutes: session.totalIdleMinutes,
    idleFeeIntervalsApplied: session.idleFeeIntervalsApplied,
    minBalanceRequired: session.minBalanceRequired,
  };
};

exports.startImmediateCharge = asyncHandler(async (req, res) => {
  const { bookingId } = req.body;
  if (!bookingId) {
    throw new HttpError(400, "bookingId is required");
  }

  const userId = ensureRequestUserId(req);

  const booking = await Booking.findOne(buildBookingQuery(userId, bookingId));
  if (!booking) {
    throw new HttpError(404, "Booking not found");
  }

  if (booking.status !== BOOKING_STATUS.RESERVED) {
    throw new HttpError(409, "Booking is not ready for check-in");
  }

  const now = new Date();
  // if (now < new Date(booking.slotStart)) {
  //   throw new HttpError(409, "Cannot start charging before the reserved slot");
  // }

  if (now > new Date(booking.checkInDeadline)) {
    throw new HttpError(409, "Booking check-in window has expired");
  }

  const existingSession = await Session.findOne({ bookingId: booking._id });
  if (existingSession) {
    if (existingSession.status === SESSION_STATUS.CHARGING) {
      throw new HttpError(
        409,
        "Charging session already started for this booking"
      );
    }
    throw new HttpError(409, "Booking already has a recorded session");
  }

  const wallet = await Wallet.findOne({ user_id: userId });
  if (!wallet || wallet.balance < SESSION_MIN_BALANCE_BASE_VND) {
    throw new HttpError(
      402,
      `Minimum balance of ${SESSION_MIN_BALANCE_BASE_VND.toLocaleString()} VND is required to start`
    );
  }

  const connector = await Connector.findOneAndUpdate(
    { _id: booking.connectorId, status: "RESERVED" },
    { status: "CHARGING" },
    { new: true }
  );

  if (!connector) {
    throw new HttpError(
      409,
      "Connector is no longer reserved for this booking"
    );
  }

  cancelNoShowJob(booking._id);

  let batteryKwh =
    booking.vehicle?.batteryKwh && Number(booking.vehicle.batteryKwh) > 0
      ? Number(booking.vehicle.batteryKwh)
      : null;

  if (!batteryKwh && booking.vehicleId) {
    const linkedVehicle = await Vehicle.findOne({
      id: booking.vehicleId,
      userId: booking.userId,
    })
      .select("batteryKwh")
      .lean();

    if (linkedVehicle?.batteryKwh && Number(linkedVehicle.batteryKwh) > 0) {
      batteryKwh = Number(linkedVehicle.batteryKwh);
    }
  }

  const parsedConnectorPower = Number(connector.powerKw);
  const connectorPowerKw =
    Number.isFinite(parsedConnectorPower) && parsedConnectorPower > 0
      ? parsedConnectorPower
      : null;

  const socStart = randomIntInclusive(
    SESSION_SOC_RANDOM_MIN,
    SESSION_SOC_RANDOM_MAX
  );
  const requestedChargeDuration = computeChargeDurationMinutes(socStart);
  const startedAt = now;
  const slotEnd = new Date(booking.slotEnd);
  const availableMinutes = Math.max(
    1,
    Math.ceil((slotEnd.getTime() - startedAt.getTime()) / 60000)
  );
  const chargeDurationMinutes = Math.min(
    requestedChargeDuration,
    availableMinutes
  );
  const expectedFullAt = new Date(
    startedAt.getTime() + chargeDurationMinutes * 60 * 1000
  );
  const idleFeeNoticeAt =
    expectedFullAt < slotEnd
      ? new Date(
          expectedFullAt.getTime() +
            SESSION_IDLE_FEE_INTERVAL_MINUTES * 60 * 1000
        )
      : null;

  const session = await Session.create({
    bookingId: booking._id,
    bookingRef: booking.id,
    userId,
    stationId: booking.stationId,
    connectorId: booking.connectorId,
    status: SESSION_STATUS.CHARGING,
    socStart,
    socTarget: 100,
    startedAt,
    expectedFullAt,
    idleFeeNoticeAt,
    slotEnd,
    chargeDurationMinutes,
    idleFeeIntervalMinutes: SESSION_IDLE_FEE_INTERVAL_MINUTES,
    minBalanceRequired: SESSION_MIN_BALANCE_BASE_VND,
  });

  const sessionPayload = formatSessionPayload(session);
  startSessionBroadcast(sessionPayload, {
    batteryKwh,
    connectorPowerKw,
  });

  booking.status = BOOKING_STATUS.CHECKED_IN;
  await booking.save();
  bookingMonitor.syncBooking(booking);

  res.status(201).json({
    message: "Charging session started",
    session: sessionPayload,
    notices:
      idleFeeNoticeAt && idleFeeNoticeAt < slotEnd
        ? [
            "Battery is expected to reach 100% before the slot ends. Please vacate the connector to avoid idle fees.",
          ]
        : [],
  });
});

exports.stopSession = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = ensureRequestUserId(req);

  const session = await Session.findOne(buildSessionQuery(userId, id));
  if (!session) {
    throw new HttpError(404, "Session not found");
  }

  if (session.status !== SESSION_STATUS.CHARGING) {
    throw new HttpError(409, "Session is not currently charging");
  }

  if (!session.startedAt) {
    throw new HttpError(500, "Session start timestamp is missing");
  }

  const now = new Date();
  // const elapsedMinutes = (now.getTime() - session.startedAt.getTime()) / 60000;
  // const socEnd = computeSocAtStop(session, elapsedMinutes);
  // const totalChargingMinutes = Math.min(
  //   elapsedMinutes,
  //   session.chargeDurationMinutes
  // );
  // const totalIdleMinutes = Math.max(
  //   0,
  //   elapsedMinutes - session.chargeDurationMinutes
  // );
  // const idleFeeIntervalsApplied = Math.floor(
  //   totalIdleMinutes / session.idleFeeIntervalMinutes
  // );

  // session.status = SESSION_STATUS.COMPLETED;
  // session.socEnd = socEnd;
  // session.stoppedAt = now;
  // session.totalChargingMinutes = Number(totalChargingMinutes.toFixed(1));
  // session.totalIdleMinutes = Number(totalIdleMinutes.toFixed(1));
  // session.idleFeeIntervalsApplied = idleFeeIntervalsApplied;

  // await session.save();

  // await Connector.findByIdAndUpdate(session.connectorId, { status: "IDLE" });
  // const updatedBooking = await Booking.findByIdAndUpdate(
  //   session.bookingId,
  //   {
  //     status: BOOKING_STATUS.COMPLETED,
  //   },
  //   { new: true }
  // );

  // if (updatedBooking) {
  //   bookingMonitor.syncBooking(updatedBooking);
  // }

  // const payload = formatSessionPayload(session);
  const finalizedSession = await completeSession(session, { stoppedAt: now });
  const payload = formatSessionPayload(finalizedSession);
  finalizeSessionBroadcast(payload);
  
  const notices = [];
  if (finalizedSession.socEnd >= 100 && now < finalizedSession.slotEnd) {
    notices.push(
      "Vehicle hit 100% before the slot ended. Please free the connector for the next driver."
    );
  }
  if (finalizedSession.idleFeeIntervalsApplied > 0) {
    notices.push(
      `Idle fees apply for ${finalizedSession.idleFeeIntervalsApplied} interval(s) of ${SESSION_IDLE_FEE_INTERVAL_MINUTES} minutes.`
    );
  }

  res.json({
    message: "Charging session stopped",
    session: payload,
    notices,
  });
});
