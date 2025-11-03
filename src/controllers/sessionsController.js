const mongoose = require("mongoose");
const Session = require("../models/Session");
const Booking = require("../models/Booking");
const Connector = require("../models/Connector");
const Vehicle = require("../models/Vehicle");
const Wallet = require("../models/Wallet");
const Tariff = require("../models/Tariff");

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
const {
  formatSessionDates,
  formatToVietnamTime,
} = require("../utils/timezoneHelpers");
const { safeNotifyUser } = require("../services/notificationService");
const {
  calculateChargeDurationFromSoc,
  calculateChargePercentageIn30Min,
  calculateTimeToFullCharge,
} = require("../utils/algorithms");

// === UTILS ===
const randomIntInclusive = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toObjectId = (value) => {
  if (!value) return null;
  if (mongoose.Types.ObjectId.isValid(value)) {
    return new mongoose.Types.ObjectId(value);
  }
  return null;
};

const parseDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const STATUS_SET = new Set(Object.values(SESSION_STATUS));

const parseStatuses = (raw) => {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter((t) => STATUS_SET.has(t));
};

const parseSort = (raw) => {
  const defaultSort = { startedAt: -1 };
  if (!raw) return defaultSort;

  const allowed = new Set(["startedAt", "stoppedAt", "createdAt", "updatedAt"]);
  const sortSpec = {};
  String(raw)
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean)
    .forEach((f) => {
      let name = f,
        dir = 1;
      if (f.startsWith("-")) {
        dir = -1;
        name = f.slice(1);
      }
      if (f.startsWith("+")) name = f.slice(1);
      if (allowed.has(name)) sortSpec[name] = dir;
    });
  return Object.keys(sortSpec).length ? sortSpec : defaultSort;
};

const toPlain = (value) =>
  value && typeof value.toObject === "function" ? value.toObject() : value;

const baseSessionPayload = (sessionDoc) => {
  const session = formatSessionDates(toPlain(sessionDoc));
  return {
    _id: session._id?.toString(),
    id: session.id,
    bookingId: session.bookingRef || session.bookingId?.toString(),
    bookingRef: session.bookingRef,
    connectorId: session.connectorId?.toString(),
    stationId: session.stationId?.toString(),
    userId: session.userId,
    status: session.status,
    socStart: session.socStart,
    socEnd: session.socEnd,
    socTarget: session.socTarget,
    startedAt: session.startedAt,
    expectedFullAt: session.expectedFullAt,
    idleFeeNoticeAt: session.idleFeeNoticeAt,
    stoppedAt: session.stoppedAt,
    slotEnd: session.slotEnd,
    chargeDurationMinutes: session.chargeDurationMinutes,
    idleFeeIntervalMinutes: session.idleFeeIntervalMinutes,
    totalChargingMinutes: session.totalChargingMinutes,
    totalIdleMinutes: session.totalIdleMinutes,
    idleFeeIntervalsApplied: session.idleFeeIntervalsApplied,
    minBalanceRequired: session.minBalanceRequired,
    pricing: session.pricing,
    billing: session.billing,
    chargingPredictions: session.chargingPredictions || {
      chargePercentageIn30Min: 0,
      timeToFullChargeMinutes: null,
      energyChargedKwh: 0,
      energyRemainingKwh: 0,
    },
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
};

const shapeSession = (doc) => {
  if (!doc) return null;
  const booking = toPlain(doc.booking) || null;
  const station = toPlain(doc.station) || null;
  const connector = toPlain(doc.connector) || null;
  const user = toPlain(doc.user) || null;

  return {
    ...baseSessionPayload(doc),
    booking: booking
      ? {
          id: booking.id,
          status: booking.status,
          slotStart: booking.slotStart,
          slotEnd: booking.slotEnd,
          userId: booking.userId,
        }
      : null,
    station: station
      ? {
          id: station._id?.toString() || null,
          name: station.name,
          code: station.code,
          status: station.status,
        }
      : null,
    connector: connector
      ? {
          id: connector._id?.toString() || null,
          code: connector.code,
          status: connector.status,
          type: connector.type,
          powerKw: connector.powerKw,
        }
      : null,
    user: user
      ? {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
        }
      : null,
  };
};

const notifySessionStoppedByAdmin = async (session) => {
  if (!session?.userId) return;
  await safeNotifyUser({
    userId: session.userId,
    title: "Charging session stopped by admin",
    body: `Your charging session ${session.id} was stopped by an administrator at ${
      formatToVietnamTime(session.stoppedAt) || formatToVietnamTime(new Date())
    }.`,
    type: "session",
    data: {
      sessionId: session.id,
      bookingId: session.bookingRef || session.bookingId?.toString() || null,
      status: session.status,
      stoppedAt: formatToVietnamTime(session.stoppedAt),
    },
  });
};

const buildBookingQuery = (userId, reference) => {
  const query = { userId, $or: [{ id: reference }] };
  if (mongoose.Types.ObjectId.isValid(reference)) {
    query.$or.push({ _id: reference });
  }
  return query;
};

const buildSessionQuery = (userId, reference) => {
  const query = { userId, $or: [{ id: reference }] };
  if (mongoose.Types.ObjectId.isValid(reference)) {
    query.$or.push({ _id: reference });
  }
  return query;
};

const resolveConfiguredChargeDurationMinutes = () => {
  const raw = process.env.SESSION_CHARGE_DURATION_MINUTES;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const computeChargeDurationMinutes = (
  socStart,
  socTarget,
  batteryKwh,
  connectorPowerKw
) => {
  const configured = resolveConfiguredChargeDurationMinutes();
  const maxMinutes = BOOKING_SLOT_MINUTES;
  if (configured) return Math.min(maxMinutes, Math.round(configured));
  if (batteryKwh && connectorPowerKw) {
    const calculated = calculateChargeDurationFromSoc(
      socStart,
      socTarget || 100,
      batteryKwh,
      connectorPowerKw
    );
    return Math.min(maxMinutes, Math.round(calculated));
  }
  return maxMinutes;
};

// === CONTROLLER METHODS ===

exports.startImmediateCharge = asyncHandler(async (req, res) => {
  const { bookingId } = req.body;
  if (!bookingId) throw new HttpError(400, "bookingId is required");

  const userId = ensureRequestUserId(req);
  const booking = await Booking.findOne(buildBookingQuery(userId, bookingId));
  if (!booking) throw new HttpError(404, "Booking not found");
  if (booking.status !== BOOKING_STATUS.RESERVED) {
    throw new HttpError(409, "Booking is not ready for check-in");
  }

  const now = new Date();
  if (now > new Date(booking.checkInDeadline)) {
    throw new HttpError(409, "Booking check-in window has expired");
  }

  if (await Session.findOne({ bookingId: booking._id })) {
    throw new HttpError(409, "Session already exists for this booking");
  }

  const wallet = await Wallet.findOne({ user_id: userId });
  if (!wallet || wallet.balance < SESSION_MIN_BALANCE_BASE_VND) {
    throw new HttpError(
      402,
      `Minimum balance of ${SESSION_MIN_BALANCE_BASE_VND.toLocaleString()} VND is required`
    );
  }

  const connector = await Connector.findOneAndUpdate(
    { _id: booking.connectorId, status: "RESERVED" },
    { status: "CHARGING" },
    { new: true }
  );
  if (!connector) throw new HttpError(409, "Connector is no longer reserved");

  cancelNoShowJob(booking._id);

  let batteryKwh =
    booking.vehicle?.batteryKwh > 0 ? booking.vehicle.batteryKwh : null;
  if (!batteryKwh && booking.vehicleId) {
    const vehicle = await Vehicle.findOne({ id: booking.vehicleId, userId })
      .select("batteryKwh")
      .lean();
    if (vehicle?.batteryKwh > 0) batteryKwh = vehicle.batteryKwh;
  }

  const connectorPowerKw = connector.powerKw > 0 ? connector.powerKw : null;
  const socStart = randomIntInclusive(
    SESSION_SOC_RANDOM_MIN,
    SESSION_SOC_RANDOM_MAX
  );
  const chargeDurationMinutes = computeChargeDurationMinutes(
    socStart,
    100,
    batteryKwh,
    connectorPowerKw
  );
  const startedAt = now;
  const slotEnd = new Date(booking.slotEnd);
  const availableMinutes = Math.max(
    1,
    Math.ceil((slotEnd - startedAt) / 60000)
  );
  const finalDuration = Math.min(chargeDurationMinutes, availableMinutes);
  const expectedFullAt = new Date(
    startedAt.getTime() + finalDuration * 60 * 1000
  );

  const chargePercentageIn30Min =
    batteryKwh && connectorPowerKw
      ? calculateChargePercentageIn30Min(socStart, batteryKwh, connectorPowerKw)
      : 0;
  const timeToFullChargeMinutes =
    batteryKwh && connectorPowerKw
      ? calculateTimeToFullCharge(socStart, batteryKwh, connectorPowerKw)
      : null;
  const energyRemainingKwh = batteryKwh
    ? ((100 - socStart) / 100) * batteryKwh
    : 0;

  const tariff = await Tariff.findEffectiveAt(
    booking.stationId,
    connector.type,
    startedAt
  );
  const pricingSnapshot = tariff
    ? {
        tariffId: tariff._id,
        mode: tariff.mode,
        connectorType: tariff.connectorType,
        pricePerMin: toNumber(tariff.pricePerMin, 0),
        idleFeePerMin: toNumber(tariff.idleFeePerMin, 0),
        pricePerKwh: toNumber(tariff.pricePerKwh, 0),
        graceMin: toNumber(tariff.graceMin, 0),
        currency: "VND",
        effectiveFrom: tariff.effectiveFrom,
      }
    : { currency: "VND" };

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
    idleFeeNoticeAt: expectedFullAt < slotEnd ? expectedFullAt : null,
    slotEnd,
    chargeDurationMinutes: finalDuration,
    idleFeeIntervalMinutes: SESSION_IDLE_FEE_INTERVAL_MINUTES,
    minBalanceRequired: SESSION_MIN_BALANCE_BASE_VND,
    pricing: pricingSnapshot,
    billing: { currency: pricingSnapshot.currency },
    chargingPredictions: {
      chargePercentageIn30Min,
      timeToFullChargeMinutes,
      energyChargedKwh: 0,
      energyRemainingKwh,
    },
  });

  const payload = baseSessionPayload(session);
  startSessionBroadcast(payload, { batteryKwh, connectorPowerKw });

  booking.status = BOOKING_STATUS.CHECKED_IN;
  await booking.save();
  bookingMonitor.syncBooking(booking);

  const notices =
    expectedFullAt < slotEnd
      ? [
          "Battery expected to reach 100% before slot ends. Please vacate to avoid idle fees.",
        ]
      : [];

  res.status(201).json({
    message: "Charging session started",
    session: payload,
    notices,
  });
});

exports.stopSession = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = ensureRequestUserId(req);

  const session = await Session.findOne(buildSessionQuery(userId, id));
  if (!session) throw new HttpError(404, "Session not found");

  if (
    ![SESSION_STATUS.CHARGING, SESSION_STATUS.COMPLETED].includes(
      session.status
    )
  ) {
    throw new HttpError(409, "Session cannot be stopped in its current state");
  }

  const now = new Date();
  const finalized = await completeSession(session, { stoppedAt: now });
  if (!finalized) throw new HttpError(500, "Failed to finalize session");

  const payload = baseSessionPayload(finalized);
  finalizeSessionBroadcast(payload);

  if (finalized.bookingId) {
    const booking = await Booking.findById(finalized.bookingId);
    if (booking && booking.status !== BOOKING_STATUS.COMPLETED) {
      booking.status = BOOKING_STATUS.COMPLETED;
      await booking.save();
      bookingMonitor.syncBooking(booking);
    }
  }

  await Connector.findByIdAndUpdate(finalized.connectorId, { status: "IDLE" });

  const notices = [];
  if (finalized.socEnd >= 100 && now < finalized.slotEnd) {
    notices.push("Vehicle reached 100%. Please free the connector.");
  }
  if (finalized.idleFeeIntervalsApplied > 0) {
    notices.push(
      `Idle fees applied for ${finalized.idleFeeIntervalsApplied} interval(s).`
    );
  }

  await notifySessionStoppedByAdmin(finalized);

  res.json({
    message: "Charging session stopped",
    session: payload,
    notices,
  });
});

exports.listSessions = asyncHandler(async (req, res) => {
  const {
    status,
    userId,
    stationId,
    connectorId,
    from,
    to,
    search,
    page = 1,
    limit = 20,
    sort,
  } = req.query;

  const match = {};
  if (status) match.status = { $in: parseStatuses(status) };
  if (userId) match.userId = userId;
  if (stationId) match.stationId = toObjectId(stationId);
  if (connectorId) match.connectorId = toObjectId(connectorId);
  if (from || to) {
    match.startedAt = {};
    if (from) match.startedAt.$gte = parseDate(from);
    if (to) match.startedAt.$lte = parseDate(to);
  }

  if (search) {
    const keyword = String(search).trim();
    if (keyword) {
      const regex = new RegExp(
        keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      );
      const or = [
        { id: keyword },
        { bookingRef: keyword },
        { userId: keyword },
        { id: { $regex: regex } },
      ];
      match.$or ? (match.$and = [match, { $or }]) : (match.$or = or);
    }
  }

  const pageNumber = Math.max(1, Number(page));
  const pageSize = Math.min(100, Math.max(1, Number(limit)));
  const skip = (pageNumber - 1) * pageSize;
  const sortSpec = parseSort(sort);

  const pipeline = [
    { $match: match },
    {
      $facet: {
        metadata: [{ $count: "total" }],
        items: [
          { $sort: sortSpec },
          { $skip: skip },
          { $limit: pageSize },
          {
            $lookup: {
              from: "bookings",
              localField: "bookingId",
              foreignField: "_id",
              as: "booking",
            },
          },
          { $unwind: { path: "$booking", preserveNullAndEmptyArrays: true } },
          {
            $lookup: {
              from: "stations",
              localField: "stationId",
              foreignField: "_id",
              as: "station",
            },
          },
          { $unwind: { path: "$station", preserveNullAndEmptyArrays: true } },
          {
            $lookup: {
              from: "connectors",
              localField: "connectorId",
              foreignField: "_id",
              as: "connector",
            },
          },
          { $unwind: { path: "$connector", preserveNullAndEmptyArrays: true } },
          {
            $lookup: {
              from: "users",
              localField: "userId",
              foreignField: "id",
              as: "user",
            },
          },
          { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
        ],
      },
    },
    {
      $project: {
        items: 1,
        total: { $ifNull: [{ $first: "$metadata.total" }, 0] },
      },
    },
  ];

  const [result] = await Session.aggregate(pipeline);
  const total = result?.total || 0;
  const items = (result?.items || []).map(shapeSession);

  res.json({
    pagination: {
      page: pageNumber,
      limit: pageSize,
      total,
      pages: Math.ceil(total / pageSize),
    },
    items,
  });
});

exports.getSession = asyncHandler(async (req, res) => {
  const session = await Session.findOne({
    $or: [{ id: req.params.id }, { _id: toObjectId(req.params.id) }],
  });

  if (!session) throw new HttpError(404, "Session not found");

  const detailed = await Session.aggregate([
    { $match: { _id: session._id } },
    {
      $lookup: {
        from: "bookings",
        localField: "bookingId",
        foreignField: "_id",
        as: "booking",
      },
    },
    { $unwind: { path: "$booking", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "stations",
        localField: "stationId",
        foreignField: "_id",
        as: "station",
      },
    },
    { $unwind: { path: "$station", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "connectors",
        localField: "connectorId",
        foreignField: "_id",
        as: "connector",
      },
    },
    { $unwind: { path: "$connector", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "users",
        localField: "userId",
        foreignField: "id",
        as: "user",
      },
    },
    { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
  ]).then((res) => (res[0] ? shapeSession(res[0]) : null));

  res.json({ session: detailed });
});
