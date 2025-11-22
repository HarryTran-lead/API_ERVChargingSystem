// src/controllers/bookingController.js
const mongoose = require('mongoose');

const Booking = require('../models/Booking');
const Connector = require('../models/Connector');
const Vehicle = require('../models/Vehicle');
const Wallet = require("../models/Wallet");
const Station = require('../models/Station');
const Charger = require("../models/Charger");
const Tariff = require('../models/Tariff');
const Session = require('../models/Session');
const Invoice = require('../models/Invoice');

const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../utils/errors');
const {
  ensureRequestUserId,
  ensureRequestUser,
} = require("../utils/requestUser");
const {
  BOOKING_SLOT_MINUTES,
  BOOKING_GRACE_MINUTES,
  SESSION_MIN_BALANCE_BASE_VND,
} = require("../constants/business");
const { BOOKING_STATUS, SESSION_STATUS, PAYMENT_METHODS, ROLES } = require('../constants/enums'); // NEW PAYMENT_METHODS
const { scheduleNoShowJob, cancelNoShowJob } = require('../services/bookingScheduler');
const bookingMonitor = require('../services/bookingMonitor');
const { formatBookingDates, formatToVietnamTime, formatInvoiceDates } = require('../utils/timezoneHelpers'); // NEW formatInvoiceDates
const { completeSessionByReference } = require('../services/sessionFinalizer');
const { safeNotifyUser } = require('../services/notificationService');
const { settleSessionPayment } = require('../services/sessionPaymentSettlement'); // NEW
const { resolveConflict } = require("../services/bookingConflictResolver");

// ========== Utils ==========
const toMinutes = (ms) => ms / (60 * 1000);

const vehicleSnapshotFromDoc = (v) => {
  if (!v) return undefined;
  return {
    id: v.id, // UUID công khai (string theo model Vehicle)
    make: v.make,
    model: v.model,
    plugType: v.plug_type, // map snake_case -> camelCase
    batteryKwh: v.battery_kwh,
    licensePlate: v.license_plate,
  };
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

const STATUS_SET = new Set(Object.values(BOOKING_STATUS));

const parseStatuses = (raw) => {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter((t) => STATUS_SET.has(t));
};

const parseSort = (raw) => {
  const defaultSort = { slotStart: -1 };
  if (!raw) return defaultSort;

  const allowed = new Set(['slotStart', 'slotEnd', 'createdAt', 'updatedAt']);
  const sortSpec = {};

  String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((field) => {
      let name = field;
      let direction = 1;
      if (field.startsWith('-')) {
        direction = -1;
        name = field.slice(1);
      } else if (field.startsWith('+')) {
        name = field.slice(1);
      }
      if (allowed.has(name)) {
        sortSpec[name] = direction;
      }
    });

  return Object.keys(sortSpec).length > 0 ? sortSpec : defaultSort;
};

const shapeBooking = (doc) => {
  if (!doc) return null;

  const station = doc.station || null;
  const connector = doc.connector || null;
  const user = doc.user || null;
  const session = doc.session || null;

  const booking = formatBookingDates({
    ...doc,
    station: station
      ? {
          id: station._id?.toString() || null,
          name: station.name,
          code: station.code,
          status: station.status,
          address: station.address,
          province: station.province,
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
    session: session
      ? {
          id: session.id,
          status: session.status,
          startedAt: session.startedAt,
          stoppedAt: session.stoppedAt,
          billing: session.billing,
        }
      : null,
  });

  if (booking._id) booking._id = booking._id.toString();
  if (booking.stationId) booking.stationId = booking.stationId.toString();
  if (booking.connectorId) booking.connectorId = booking.connectorId.toString();

  // NEW defaults from patch
  booking.paymentMethod = booking.paymentMethod || PAYMENT_METHODS.WALLET;
  booking.createdByStaffId = booking.createdByStaffId || null;
  booking.walkInInfo = booking.walkInInfo || null;
  booking.isPaid = Boolean(booking.isPaid);
  return booking;
};

const notifyBookingStatusChange = async (booking, status) => {
  if (!booking?.userId) return;

  await safeNotifyUser({
    userId: booking.userId,
    title: `Booking ${status.toLowerCase()}`,
    body: `Your booking ${booking.id || booking._id?.toString?.()} is now ${status}.`,
    type: 'booking',
    data: {
      bookingId: booking.id,
      status,
      slotStart: formatToVietnamTime(booking.slotStart),
      slotEnd: formatToVietnamTime(booking.slotEnd),
      stationId: booking.stationId?.toString() || null,
      connectorId: booking.connectorId?.toString() || null,
    },
  });
};

const findBookingByParam = async (param) => {
  const query = { $or: [{ id: param }] };
  if (mongoose.Types.ObjectId.isValid(param)) {
    query.$or.push({ _id: new mongoose.Types.ObjectId(param) });
  }
  return Booking.findOne(query);
};

const populateBookingDetails = async (booking) => {
  if (!booking) return null;

  const [result] = await Booking.aggregate([
    { $match: { _id: booking._id } },
    {
      $lookup: {
        from: 'stations',
        localField: 'stationId',
        foreignField: '_id',
        as: 'station',
      },
    },
    { $unwind: { path: '$station', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'connectors',
        localField: 'connectorId',
        foreignField: '_id',
        as: 'connector',
      },
    },
    { $unwind: { path: '$connector', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'users',
        localField: 'userId',
        foreignField: 'id',
        as: 'user',
      },
    },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'sessions',
        localField: '_id',
        foreignField: 'bookingId',
        as: 'session',
      },
    },
    { $unwind: { path: '$session', preserveNullAndEmptyArrays: true } },
  ]);

  return result ? shapeBooking(result) : null;
};

// ========== Controllers ==========

// POST /api/v1/bookings
exports.createBooking = asyncHandler(async (req, res) => {
  const { connectorId, slotStart, vehicleId } = req.body;
  if (!connectorId || !slotStart) {
    throw new HttpError(400, "connectorId and slotStart are required");
  }

  // Không cho client tự đính kèm snapshot xe — server sẽ tự lấy từ xe mặc định
  if (req.body.vehicle) {
    throw new HttpError(
      400,
      "Do not send vehicle details; the server uses your default vehicle."
    );
  }

  const userId = ensureRequestUserId(req);

  const start = new Date(slotStart);
  if (Number.isNaN(start.getTime())) {
    throw new HttpError(400, "Invalid slotStart value");
  }

  const normalizedStart = new Date(start);
  normalizedStart.setSeconds(0, 0);

  const now = new Date();
  if (
    normalizedStart.getTime() + BOOKING_SLOT_MINUTES * 60000 <=
    now.getTime()
  ) {
    throw new HttpError(400, "Slot must be in the future");
  }

  // Bắt buộc phải có xe mặc định
  const defaultVehicle = await Vehicle.findOne({
    user_id: userId,
    is_default: true,
    deleted_at: null,
  }).lean();

  if (!defaultVehicle) {
    throw new HttpError(
      409,
      "DEFAULT_VEHICLE_REQUIRED: You must register a vehicle and set a default vehicle before booking."
    );
  }

  // Nếu gửi vehicleId thì bắt buộc phải là xe mặc định
  if (vehicleId && vehicleId !== defaultVehicle.id) {
    throw new HttpError(
      400,
      "MUST_USE_DEFAULT_VEHICLE: You can only book with your default vehicle."
    );
  }

  const wallet = await Wallet.findOne({ user_id: userId }).lean();

  if (!wallet || wallet.balance <= SESSION_MIN_BALANCE_BASE_VND) {
    const formattedMin = SESSION_MIN_BALANCE_BASE_VND.toLocaleString("vi-VN");
    throw new HttpError(
      402,
      `WALLET_MIN_BALANCE_REQUIRED: Your wallet must have a balance above ${formattedMin} VND to create a booking.`
    );
  }

  // Kiểm tra user có booking đang active không (trừ slot liên tiếp)
  const userActiveBookings = await Booking.find({
    userId,
    status: { $in: [BOOKING_STATUS.RESERVED, BOOKING_STATUS.CHECKED_IN] },
  }).lean();

  // // Giới hạn tối đa 2 booking active cùng lúc
  // if (userActiveBookings.length >= 2) {
  //   throw new HttpError(
  //     409,
  //     "You can only have maximum 2 active bookings at a time."
  //   );
  // }

  // Kiểm tra xem user/vehicle đã có booking nào với cùng slot time chưa (bất kể trạm nào)
  // Ràng buộc: một xe không thể book cùng một giờ ở nhiều trạm khác nhau
  const slotEnd = new Date(
    normalizedStart.getTime() + BOOKING_SLOT_MINUTES * 60 * 1000
  );
  
  const conflictingBooking = await Booking.findOne({
    userId,
    status: { $in: [BOOKING_STATUS.RESERVED, BOOKING_STATUS.CHECKED_IN] },
    // Check for overlapping slot time (same slot time or overlapping)
    $or: [
      // Exact same slot time
      {
        slotStart: normalizedStart,
      },
      // Overlapping slot times
      {
        slotStart: { $lt: slotEnd },
        slotEnd: { $gt: normalizedStart },
      },
    ],
  }).lean();

  if (conflictingBooking) {
    const conflictStation = await Station.findById(conflictingBooking.stationId).lean();
    const conflictStationName = conflictStation?.name || 'Unknown Station';
    const conflictTime = formatToVietnamTime(conflictingBooking.slotStart);
    
    throw new HttpError(
      409,
      `VEHICLE_ALREADY_BOOKED: Your vehicle is already booked for this time slot (${conflictTime}) at ${conflictStationName}. You cannot book the same time slot at another station.`
    );
  }

  // // Giới hạn 3 slot/ngày
  // const today = new Date();
  // today.setHours(0, 0, 0, 0);
  // const tomorrow = new Date(today);
  // tomorrow.setDate(tomorrow.getDate() + 1);

  // const todayBookings = await Booking.countDocuments({
  //   userId,
  //   slotStart: { $gte: today, $lt: tomorrow },
  //   status: { $ne: BOOKING_STATUS.CANCELLED },
  // });

  // if (todayBookings >= 3) {
  //   throw new HttpError(429, 'Daily limit reached. You can only book 3 slots per day.');
  // }

  const checkInDeadline = new Date(
    normalizedStart.getTime() + BOOKING_GRACE_MINUTES * 60 * 1000
  );

  // // Chống đặt chồng lấp trên cùng connector
  // const overlapping = await Booking.findOne({
  //   connectorId,
  //   status: { $in: [BOOKING_STATUS.RESERVED, BOOKING_STATUS.CHECKED_IN] },
  //   slotStart: { $lt: slotEnd },
  //   slotEnd: { $gt: normalizedStart },
  // }).lean();

  // if (overlapping) {
  //   const overlapMinutes = Math.round(
  //     toMinutes(
  //       Math.min(new Date(overlapping.slotEnd).getTime(), slotEnd.getTime()) -
  //         Math.max(new Date(overlapping.slotStart).getTime(), normalizedStart.getTime())
  //     )
  //   );
  //   throw new HttpError(
  //     409,
  //     `Connector already reserved for the selected slot (overlap ${overlapMinutes} minutes)`
  //   );
  // }

  const vehicleSnapshot = vehicleSnapshotFromDoc(defaultVehicle);

  let connectorDoc;
  let shouldReleaseConnector = false;
  let releaseStatus = null;
  try {
    // // Reserve connector nếu đang IDLE
    // connectorDoc = await Connector.findOneAndUpdate(
    //   { _id: connectorId, status: 'IDLE' },
    //   { $set: { status: 'RESERVED' } },
    //   { new: true }
    // );
    connectorDoc = await Connector.findById(connectorId);

    if (!connectorDoc) {
      throw new HttpError(404, "Connector not found");
    }

    if (connectorDoc.status === "OFFLINE") {
      throw new HttpError(409, "Connector is offline");
    }

    if (["IDLE", "FINISHED"].includes(connectorDoc.status)) {
      const updated = await Connector.findOneAndUpdate(
        { _id: connectorId, status: connectorDoc.status },
        { $set: { status: "RESERVED" } },
        { new: true }
      );

      if (updated) {
        releaseStatus = connectorDoc.status;
        shouldReleaseConnector = true;
        connectorDoc = updated;
      } else {
        connectorDoc = await Connector.findById(connectorId);
        if (!connectorDoc) {
          throw new HttpError(404, "Connector not found");
        }
        if (connectorDoc.status === "OFFLINE") {
          throw new HttpError(409, "Connector is offline");
        }
      }
    } else if (!["RESERVED", "CHARGING"].includes(connectorDoc.status)) {
      throw new HttpError(409, "Connector is not available for booking");
    }

    const overlapping = await Booking.findOne({
      connectorId,
      status: { $in: [BOOKING_STATUS.RESERVED, BOOKING_STATUS.CHECKED_IN] },
      slotStart: { $lt: slotEnd },
      slotEnd: { $gt: normalizedStart },
    }).lean();

    if (overlapping) {
      if (shouldReleaseConnector && connectorDoc.status === "RESERVED") {
        await Connector.findOneAndUpdate(
          { _id: connectorDoc._id, status: "RESERVED" },
          { $set: { status: releaseStatus || "IDLE" } }
        );
        shouldReleaseConnector = false;
      }

      const overlapMinutes = Math.round(
        toMinutes(
          Math.min(new Date(overlapping.slotEnd).getTime(), slotEnd.getTime()) -
            Math.max(
              new Date(overlapping.slotStart).getTime(),
              normalizedStart.getTime()
            )
        )
      );
      throw new HttpError(
        409,
        `Connector already reserved for the selected slot (overlap ${overlapMinutes} minutes)`
      );
    }

    const booking = await Booking.create({
      userId,
      stationId: connectorDoc.stationId,
      connectorId,
      slotStart: normalizedStart,
      slotEnd,
      checkInDeadline,
      status: BOOKING_STATUS.RESERVED,
      vehicleId: defaultVehicle.id,
      vehicle: vehicleSnapshot,
      paymentMethod: PAYMENT_METHODS.WALLET, // NEW default
    });

    scheduleNoShowJob(booking);
    bookingMonitor.syncBooking(booking);

    // NEW: notify user on creation
    await safeNotifyUser({
      userId,
      title: "Booking confirmed",
      body: `Your booking ${booking.id} is reserved for ${formatToVietnamTime(
        booking.slotStart
      )}. Please check in before ${formatToVietnamTime(checkInDeadline)}.`,
      type: "booking",
      data: {
        bookingId: booking.id,
        status: booking.status,
        slotStart: formatToVietnamTime(booking.slotStart),
        slotEnd: formatToVietnamTime(booking.slotEnd),
        stationId:
          booking.stationId?.toString?.() ||
          connectorDoc.stationId?.toString?.(),
        connectorId: connectorDoc._id?.toString(),
      },
    });

    res.status(201).json({
      message: "Booking created successfully",
      booking: formatBookingDates(booking),
    });
  } catch (err) {
    // rollback trạng thái connector nếu lỗi
    // if (connectorDoc) {
    //   await Connector.findByIdAndUpdate(connectorDoc._id, {
    //     $set: { status: 'IDLE' },
    //   });
    if (shouldReleaseConnector && connectorDoc?._id) {
      await Connector.findOneAndUpdate(
        { _id: connectorDoc._id, status: "RESERVED" },
        { $set: { status: releaseStatus || "IDLE" } }
      );
    }
    throw err;
  }
});

// GET /api/v1/bookings/my
exports.getMyBookings = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const bookings = await Booking.find({ userId }).sort({ slotStart: -1 }).lean();

  const stationIds = new Set();
  const connectorIds = new Set();

  bookings.forEach((booking) => {
    if (booking.stationId) {
      stationIds.add(booking.stationId.toString());
    }
    if (booking.connectorId) {
      connectorIds.add(booking.connectorId.toString());
    }
  });

  const [stations, connectors] = await Promise.all([
    stationIds.size
      ? Station.find({ _id: { $in: Array.from(stationIds) } })
          .select("name")
          .lean()
      : [],
    connectorIds.size
      ? Connector.find({ _id: { $in: Array.from(connectorIds) } })
          .select("chargerId code")
          .lean()
      : [],
  ]);

  const stationNameMap = new Map(
    stations.map((station) => [station._id.toString(), station.name])
  );

  const connectorMap = new Map(
    connectors.map((connector) => [connector._id.toString(), connector])
  );

  const chargerIds = new Set();
  connectors.forEach((connector) => {
    if (connector.chargerId) {
      chargerIds.add(connector.chargerId.toString());
    }
  });

  const chargers = chargerIds.size
    ? await Charger.find({ _id: { $in: Array.from(chargerIds) } })
        .select("name")
        .lean()
    : [];

  const chargerNameMap = new Map(
    chargers.map((charger) => [charger._id.toString(), charger.name])
  );

  const formattedBookings = bookings.map((booking) => {
    const formatted = formatBookingDates(booking);
    const stationName = booking.stationId
      ? stationNameMap.get(booking.stationId.toString()) || null
      : null;
    const connectorInfo = booking.connectorId
      ? connectorMap.get(booking.connectorId.toString())
      : null;
    const chargerName = connectorInfo?.chargerId
      ? chargerNameMap.get(connectorInfo.chargerId.toString()) || null
      : null;

    return {
      ...formatted,
      stationName,
      chargerName,
      connectorName: connectorInfo?.code || null,
    };
  });

  res.json({
    bookings: formattedBookings,
  });
});

exports.resolveBookingConflict = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!id) {
    throw new HttpError(400, "booking id is required");
  }

  const operator = ensureRequestUser(req);
  const operatorRole = operator?.role || ROLES.DRIVER;
  const userId =
    operatorRole === ROLES.DRIVER ? ensureRequestUserId(req) : null;

  const query = { $or: [{ id }] };
  if (mongoose.Types.ObjectId.isValid(id)) {
    query.$or.push({ _id: new mongoose.Types.ObjectId(id) });
  }
  if (userId) {
    query.userId = userId;
  }

  const booking = await Booking.findOne(query);
  if (!booking) {
    throw new HttpError(404, "Booking not found");
  }

  if (![BOOKING_STATUS.RESERVED].includes(booking.status)) {
    throw new HttpError(
      409,
      "Only reserved bookings can be adjusted for conflicts"
    );
  }

  const decision =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body.decision
      : null;

  const normalizedDecision =
    decision && typeof decision === "object" && !Array.isArray(decision)
      ? {
          ...decision,
          type:
            typeof decision.type === "string"
              ? decision.type.toUpperCase()
              : undefined,
          connectorId: decision.connectorId
            ? String(decision.connectorId)
            : undefined,
        }
      : null;

  const result = await resolveConflict({
    booking,
    decision: normalizedDecision,
  });

  res.json({
    message: result.message,
    state: result.state,
    booking: result.booking || formatBookingDates(booking.toObject()),
    suggestion: result.suggestion || null,
    context: result.context || null,
  });
});

// POST /api/v1/bookings/:id/cancel
exports.cancelBooking = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = ensureRequestUserId(req);

  const query = { userId, $or: [{ id }] };
  if (mongoose.Types.ObjectId.isValid(id)) {
    query.$or.push({ _id: id });
  }

  const booking = await Booking.findOne(query);
  if (!booking) throw new HttpError(404, 'Booking not found');
  if (booking.status !== BOOKING_STATUS.RESERVED) {
    throw new HttpError(409, 'Only reserved bookings can be cancelled');
  }

  booking.status = BOOKING_STATUS.CANCELLED;
  await booking.save();
  bookingMonitor.syncBooking(booking);
  cancelNoShowJob(booking._id);

  await Connector.findOneAndUpdate(
    { _id: booking.connectorId, status: 'RESERVED' },
    { $set: { status: 'IDLE' } }
  );

  res.json({
    message: 'Booking cancelled successfully',
    booking: formatBookingDates(booking),
  });
});

// GET /api/v1/bookings/available-slots
exports.getAvailableSlots = asyncHandler(async (req, res) => {
  const {
    stationId,
    date,
    connectorType,
    chargerId,
    duration = BOOKING_SLOT_MINUTES,
  } = req.query;

  if (!stationId) throw new HttpError(400, "stationId is required");

  // Parse date (default to today)
  const targetDate = date ? new Date(date) : new Date();
  if (Number.isNaN(targetDate.getTime())) {
    throw new HttpError(400, "Invalid date format");
  }

  // Time range trong ngày
  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  // Lọc connector theo station + trạng thái IDLE (+ loại nếu có)
  // Lọc connector theo station + trạng thái không OFFLINE (+ loại nếu có)
  // const connectorFilter = { stationId, status: { $ne: 'OFFLINE' } };
  // Lọc connector theo station + trạng thái không OFFLINE (+ loại nếu có)
  const connectorFilter = { stationId, status: { $ne: "OFFLINE" } };
  if (chargerId) connectorFilter.chargerId = chargerId;
  if (connectorType) connectorFilter.type = connectorType;

  const connectors = await Connector.find(connectorFilter)
    .populate("stationId", "name lat lng status")
    .lean();

  if (connectors.length === 0) {
    return res.json({
      message: "No available connectors found",
      availableSlots: [],
      date: targetDate.toISOString().split("T")[0],
    });
  }

  // Bookings active trong ngày
  const existingBookings = await Booking.find({
    stationId,
    status: { $in: [BOOKING_STATUS.RESERVED, BOOKING_STATUS.CHECKED_IN] },
    slotStart: { $gte: startOfDay, $lte: endOfDay },
    ...(chargerId
      ? { connectorId: { $in: connectors.map((c) => c._id) } }
      : {}),
  }).lean();

const connectorTypes = [
  ...new Set(connectors.map((connector) => connector.type)),
];
const tariffs = await Tariff.find({
  stationId,
  connectorType: { $in: connectorTypes },
  active: true,
  effectiveFrom: { $lte: endOfDay },
})
  .sort({ connectorType: 1, effectiveFrom: -1 })
  .lean();

const tariffsByType = connectorTypes.reduce((acc, type) => {
  acc.set(type, []);
  return acc;
}, new Map());

tariffs.forEach((tariff) => {
  if (tariffsByType.has(tariff.connectorType)) {
    tariffsByType.get(tariff.connectorType).push(tariff);
  }
});

const getTariffForType = (type, at) => {
  const list = tariffsByType.get(type) || [];
  return list.find((tariff) => new Date(tariff.effectiveFrom) <= at) || null;
};


  // Sinh slots mỗi 30'
  const slots = [];
  const slotStartHour = 0; // 6 AM
  const slotEndHour = 24; // 10 PM

  for (let hour = slotStartHour; hour < slotEndHour; hour++) {
    for (let minute = 0; minute < 60; minute += 30) {
      const slotStart = new Date(targetDate);
      slotStart.setHours(hour, minute, 0, 0);

      if (slotStart < new Date()) continue;

      const slotEnd = new Date(slotStart);
      slotEnd.setMinutes(
        slotEnd.getMinutes() + Number(duration || BOOKING_SLOT_MINUTES)
      );

            const slotConnectors = connectors.map((connector) => {
              const hasOverlap = existingBookings.some((b) => {
                return (
                  b.connectorId.toString() === connector._id.toString() &&
                  b.slotStart < slotEnd &&
                  new Date(b.slotEnd) > slotStart
                );
              });

              const isAvailable = !hasOverlap;
              const tariff = isAvailable
                ? getTariffForType(connector.type, slotStart)
                : null;

              return {
                connectorId: connector._id.toString(),
                connectorCode: connector.code,
                type: connector.type,
                powerKw: connector.powerKw,
                isAvailable,
                pricing: tariff
                  ? {
                      pricePerMin: tariff.pricePerMin,
                      pricePerKwh: tariff.pricePerKwh,
                      idleFeePerMin: tariff.idleFeePerMin,
                      currency: "VND",
                      mode: tariff.mode,
                    }
                  : null,
              };
            });

            const availableCount = slotConnectors.filter(
              (c) => c.isAvailable
            ).length;
            const occupiedCount = slotConnectors.length - availableCount;
            const isSlotAvailable = availableCount > 0;

            slots.push({
              slotStart: slotStart.toISOString(),
              slotEnd: slotEnd.toISOString(),
              duration: Number(duration || BOOKING_SLOT_MINUTES),
              isAvailable: isSlotAvailable,
              availableCount,
              occupiedCount,
              totalConnectors: connectors.length,
              connectors: slotConnectors, // ← tất cả connector, có trạng thái
              station: {
                id: connectors[0].stationId._id.toString(),
                name: connectors[0].stationId.name,
                lat: connectors[0].stationId.lat,
                lng: connectors[0].stationId.lng,
                status: connectors[0].stationId.status,
              },
            });
    }
  }

  res.json({
    message: "Available slots retrieved successfully",
    date: targetDate.toISOString().split("T")[0],
    totalSlots: slots.length,
    availableSlots: slots,
  });
});

// GET /api/v1/bookings (admin/operator listing + search)
exports.listBookings = asyncHandler(async (req, res) => {
  const { status, userId, stationId, connectorId, from, to, search, page = 1, limit = 20, sort } =
    req.query;

  const statuses = parseStatuses(status);
  const match = {};

  if (statuses.length > 0) match.status = { $in: statuses };
  if (userId) match.userId = userId;
  if (toObjectId(stationId)) match.stationId = toObjectId(stationId);
  if (toObjectId(connectorId)) match.connectorId = toObjectId(connectorId);

  const startDate = parseDate(from);
  const endDate = parseDate(to);
  if (startDate || endDate) {
    match.slotStart = {};
    if (startDate) match.slotStart.$gte = startDate;
    if (endDate) match.slotStart.$lte = endDate;
  }

  if (search) {
    const keyword = String(search).trim();
    if (keyword) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      const orConditions = [
        { id: keyword },
        { userId: keyword },
        { 'vehicle.licensePlate': keyword },
        { 'vehicle.licensePlate': { $regex: regex } },
      ];
      if (match.$and) {
        match.$and.push({ $or: orConditions });
      } else if (match.$or) {
        match.$and = [{ $or: match.$or }, { $or: orConditions }];
        delete match.$or;
      } else {
        match.$or = orConditions;
      }
    }
  }

  const pageNumber = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 20));
  const skip = (pageNumber - 1) * pageSize;
  const sortSpec = parseSort(sort);

  const pipeline = [
    { $match: match },
    {
      $facet: {
        metadata: [{ $count: 'total' }],
        items: [
          { $sort: sortSpec },
          { $skip: skip },
          { $limit: pageSize },
          {
            $lookup: {
              from: 'stations',
              localField: 'stationId',
              foreignField: '_id',
              as: 'station',
            },
          },
          { $unwind: { path: '$station', preserveNullAndEmptyArrays: true } },
          {
            $lookup: {
              from: 'connectors',
              localField: 'connectorId',
              foreignField: '_id',
              as: 'connector',
            },
          },
          { $unwind: { path: '$connector', preserveNullAndEmptyArrays: true } },
          {
            $lookup: {
              from: 'users',
              localField: 'userId',
              foreignField: 'id',
              as: 'user',
            },
          },
          { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
          {
            $lookup: {
              from: 'sessions',
              localField: '_id',
              foreignField: 'bookingId',
              as: 'session',
            },
          },
          { $unwind: { path: '$session', preserveNullAndEmptyArrays: true } },
        ],
      },
    },
    {
      $project: {
        items: 1,
        total: { $ifNull: [{ $first: '$metadata.total' }, 0] },
      },
    },
  ];

  const [result] = await Booking.aggregate(pipeline);
  const total = result?.total || 0;
  const items = (result?.items || []).map(shapeBooking);

  res.json({
    pagination: {
      page: pageNumber,
      limit: pageSize,
      total,
      pages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
    },
    items,
  });
});

// GET /api/v1/bookings/:id
exports.getBooking = asyncHandler(async (req, res) => {
  const booking = await findBookingByParam(req.params.id);
  if (!booking) throw new HttpError(404, 'Booking not found');

  const detailed = await populateBookingDetails(booking);
  res.json({ booking: detailed });
});

// PATCH /api/v1/bookings/:id/status
exports.updateBookingStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!status) throw new HttpError(400, 'status is required');

  const normalizedStatus = String(status).toUpperCase();
  if (!STATUS_SET.has(normalizedStatus)) {
    throw new HttpError(400, 'Unsupported booking status');
  }

  const booking = await findBookingByParam(req.params.id);
  if (!booking) throw new HttpError(404, 'Booking not found');

  if (booking.status === normalizedStatus) {
    const detailed = await populateBookingDetails(booking);
    return res.json({
      message: 'Booking already in requested status',
      booking: detailed,
    });
  }

  // Chỉ cho phép CANCELLED, NO_SHOW, COMPLETED ở endpoint này
  if ([BOOKING_STATUS.CANCELLED, BOOKING_STATUS.NO_SHOW].includes(normalizedStatus)) {
    const allowed = [BOOKING_STATUS.RESERVED, BOOKING_STATUS.CHECKED_IN];
    if (!allowed.includes(booking.status)) {
      throw new HttpError(409, `Cannot transition from ${booking.status} to ${normalizedStatus}`);
    }

    // Không được hủy/noshow khi còn session active
    const activeSession = await Session.findOne({
      bookingId: booking._id,
      status: { $in: [SESSION_STATUS.PENDING, SESSION_STATUS.CHARGING] },
    });
    if (activeSession) {
      throw new HttpError(409, 'Booking has an active session. Stop the charging session first.');
    }

    booking.status = normalizedStatus;
    await booking.save();
    bookingMonitor.syncBooking(booking);
    cancelNoShowJob(booking._id);

    await Connector.findOneAndUpdate(
      { _id: booking.connectorId, status: { $in: ['RESERVED', 'FINISHED'] } },
      { $set: { status: 'IDLE' } }
    );

    await notifyBookingStatusChange(booking, normalizedStatus);
    const detailed = await populateBookingDetails(booking);
    return res.json({
      message: `Booking marked as ${normalizedStatus}`,
      booking: detailed,
    });
  }

  if (normalizedStatus === BOOKING_STATUS.COMPLETED) {
    const finalizedSession = await completeSessionByReference(booking._id, {
      stoppedAt: new Date(),
    });
    if (!finalizedSession) {
      throw new HttpError(
        409,
        'Unable to mark booking as completed because no session was found.'
      );
    }

    const refreshed = await Booking.findById(booking._id);
    await notifyBookingStatusChange(refreshed, BOOKING_STATUS.COMPLETED);

    // NEW: settle payment & fetch invoice
    const settlement = await settleSessionPayment(finalizedSession);

    let invoiceDoc = settlement?.invoice || null;
    if (!invoiceDoc) {
      invoiceDoc = await Invoice.findOne({ session_id: finalizedSession.id });
    }

    const invoicePlain =
      invoiceDoc && typeof invoiceDoc.toObject === 'function' ? invoiceDoc.toObject() : invoiceDoc;

    // NEW: notify user about session completion + amount/insufficient funds
    const stoppedAtHuman =
      formatToVietnamTime(finalizedSession.stoppedAt) || formatToVietnamTime(new Date());
    const totalAmount = Number(finalizedSession.billing?.totalAmount || 0);

    if (finalizedSession.userId) {
      const bodyParts = [
        `Your charging session ${finalizedSession.id} completed at ${stoppedAtHuman}.`,
      ];
      if (totalAmount > 0) {
        bodyParts.push(`Total due: ${totalAmount.toLocaleString()} VND.`);
      }
      if (settlement?.status === 'FAILED' && settlement.reason === 'INSUFFICIENT_FUNDS') {
        bodyParts.push('Wallet balance was insufficient. Please top up or arrange onsite payment.');
      }

      await safeNotifyUser({
        userId: finalizedSession.userId,
        title: 'Charging session completed',
        body: bodyParts.join(' '),
        type: 'session',
        data: {
          sessionId: finalizedSession.id,
          bookingId: booking.id,
          stoppedAt: stoppedAtHuman,
          totalAmount,
          status: finalizedSession.status,
        },
      });
    }

    // NEW: notify invoice issuance (if any)
    if (invoicePlain?.user_id) {
      const invoiceDue = formatToVietnamTime(invoicePlain.due_at);
      const invoiceParts = [
        `Invoice ${invoicePlain.id} has been issued for session ${invoicePlain.session_id}.`,
        `Total: ${invoicePlain.total.toLocaleString()} ${invoicePlain.currency}.`,
      ];
      if (invoiceDue) {
        invoiceParts.push(`Due by ${invoiceDue}.`);
      }

      await safeNotifyUser({
        userId: invoicePlain.user_id,
        title: 'Charging invoice issued',
        body: invoiceParts.join(' '),
        type: 'invoice',
        data: {
          invoiceId: invoicePlain.id,
          sessionId: invoicePlain.session_id,
          total: invoicePlain.total,
          currency: invoicePlain.currency,
          dueAt: invoiceDue,
          paymentStatus: invoicePlain.payment_status,
        },
      });
    }

    let latestBooking = await Booking.findById(booking._id);
    if (!latestBooking) {
      latestBooking = refreshed;
    }

    if (settlement?.status === "PAID" && latestBooking) {
      bookingMonitor.syncBooking(latestBooking);
    }

    const detailed = await populateBookingDetails(latestBooking);
    return res.json({
      message: 'Booking marked as completed',
      booking: detailed,
      invoice: invoicePlain ? formatInvoiceDates(invoicePlain) : null,
      settlement,
    });
  }

  throw new HttpError(
    400,
    'Only CANCELLED, NO_SHOW or COMPLETED transitions are supported via this endpoint'
  );
});
