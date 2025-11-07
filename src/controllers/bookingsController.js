// src/controllers/bookingController.js
const mongoose = require('mongoose');

const Booking = require('../models/Booking');
const Connector = require('../models/Connector');
const Vehicle = require('../models/Vehicle');
const Station = require('../models/Station');
const Tariff = require('../models/Tariff');
const Session = require('../models/Session');
const Invoice = require('../models/Invoice'); // NEW

const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../utils/errors');
const { ensureRequestUserId } = require('../utils/requestUser');
const { BOOKING_SLOT_MINUTES, BOOKING_GRACE_MINUTES } = require('../constants/business');
const { BOOKING_STATUS, SESSION_STATUS, PAYMENT_METHODS } = require('../constants/enums'); // NEW PAYMENT_METHODS
const { scheduleNoShowJob, cancelNoShowJob } = require('../services/bookingScheduler');
const bookingMonitor = require('../services/bookingMonitor');
const { formatBookingDates, formatToVietnamTime, formatInvoiceDates } = require('../utils/timezoneHelpers'); // NEW formatInvoiceDates
const { completeSessionByReference } = require('../services/sessionFinalizer');
const { safeNotifyUser } = require('../services/notificationService');
const { settleSessionPayment } = require('../services/sessionPaymentSettlement'); // NEW

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
    throw new HttpError(400, 'connectorId and slotStart are required');
  }

  // Không cho client tự đính kèm snapshot xe — server sẽ tự lấy từ xe mặc định
  if (req.body.vehicle) {
    throw new HttpError(400, 'Do not send vehicle details; the server uses your default vehicle.');
  }

  const userId = ensureRequestUserId(req);

  const start = new Date(slotStart);
  if (Number.isNaN(start.getTime())) {
    throw new HttpError(400, 'Invalid slotStart value');
  }

  const normalizedStart = new Date(start);
  normalizedStart.setSeconds(0, 0);

  const now = new Date();
  if (normalizedStart.getTime() + BOOKING_SLOT_MINUTES * 60000 <= now.getTime()) {
    throw new HttpError(400, 'Slot must be in the future');
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
      'DEFAULT_VEHICLE_REQUIRED: You must register a vehicle and set a default vehicle before booking.'
    );
  }

  // Nếu gửi vehicleId thì bắt buộc phải là xe mặc định
  if (vehicleId && vehicleId !== defaultVehicle.id) {
    throw new HttpError(400, 'MUST_USE_DEFAULT_VEHICLE: You can only book with your default vehicle.');
  }

  // Kiểm tra user có booking đang active không (trừ slot liên tiếp)
  const userActiveBookings = await Booking.find({
    userId,
    status: { $in: [BOOKING_STATUS.RESERVED, BOOKING_STATUS.CHECKED_IN] },
  }).lean();

  if (userActiveBookings.length > 0) {
    // Cho phép slot liên tiếp (cách nhau tối đa 5 phút)
    const isConsecutiveSlot = userActiveBookings.some((b) => {
      const diff = Math.abs(normalizedStart.getTime() - new Date(b.slotEnd).getTime());
      return diff <= 5 * 60 * 1000;
    });

    if (!isConsecutiveSlot) {
      throw new HttpError(
        409,
        'You already have an active booking. Only consecutive slots are allowed.'
      );
    }

    // Không quá 2 slot liên tiếp
    if (userActiveBookings.length >= 2) {
      throw new HttpError(409, 'You can only book maximum 2 consecutive slots.');
    }
  }

  // Giới hạn 3 slot/ngày
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const todayBookings = await Booking.countDocuments({
    userId,
    slotStart: { $gte: today, $lt: tomorrow },
    status: { $ne: BOOKING_STATUS.CANCELLED },
  });

  if (todayBookings >= 3) {
    throw new HttpError(429, 'Daily limit reached. You can only book 3 slots per day.');
  }

  const slotEnd = new Date(normalizedStart.getTime() + BOOKING_SLOT_MINUTES * 60 * 1000);
  const checkInDeadline = new Date(normalizedStart.getTime() + BOOKING_GRACE_MINUTES * 60 * 1000);

  // Chống đặt chồng lấp trên cùng connector
  const overlapping = await Booking.findOne({
    connectorId,
    status: { $in: [BOOKING_STATUS.RESERVED, BOOKING_STATUS.CHECKED_IN] },
    slotStart: { $lt: slotEnd },
    slotEnd: { $gt: normalizedStart },
  }).lean();

  if (overlapping) {
    const overlapMinutes = Math.round(
      toMinutes(
        Math.min(new Date(overlapping.slotEnd).getTime(), slotEnd.getTime()) -
          Math.max(new Date(overlapping.slotStart).getTime(), normalizedStart.getTime())
      )
    );
    throw new HttpError(
      409,
      `Connector already reserved for the selected slot (overlap ${overlapMinutes} minutes)`
    );
  }

  const vehicleSnapshot = vehicleSnapshotFromDoc(defaultVehicle);

  let connectorDoc;
  try {
    // Reserve connector nếu đang IDLE
    connectorDoc = await Connector.findOneAndUpdate(
      { _id: connectorId, status: 'IDLE' },
      { $set: { status: 'RESERVED' } },
      { new: true }
    );

    if (!connectorDoc) {
      throw new HttpError(409, 'Connector is not available for booking');
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
      title: 'Booking confirmed',
      body: `Your booking ${booking.id} is reserved for ${formatToVietnamTime(
        booking.slotStart
      )}. Please check in before ${formatToVietnamTime(checkInDeadline)}.`,
      type: 'booking',
      data: {
        bookingId: booking.id,
        status: booking.status,
        slotStart: formatToVietnamTime(booking.slotStart),
        slotEnd: formatToVietnamTime(booking.slotEnd),
        stationId: booking.stationId?.toString?.() || connectorDoc.stationId?.toString?.(),
        connectorId: connectorDoc._id?.toString(),
      },
    });

    res.status(201).json({
      message: 'Booking created successfully',
      booking: formatBookingDates(booking),
    });
  } catch (err) {
    // rollback trạng thái connector nếu lỗi
    if (connectorDoc) {
      await Connector.findByIdAndUpdate(connectorDoc._id, {
        $set: { status: 'IDLE' },
      });
    }
    throw err;
  }
});

// GET /api/v1/bookings/my
exports.getMyBookings = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const bookings = await Booking.find({ userId }).sort({ slotStart: -1 }).lean();

  res.json({
    bookings: bookings.map(formatBookingDates),
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
  const { stationId, date, connectorType, duration = BOOKING_SLOT_MINUTES } = req.query;

  if (!stationId) throw new HttpError(400, 'stationId is required');

  // Parse date (default to today)
  const targetDate = date ? new Date(date) : new Date();
  if (Number.isNaN(targetDate.getTime())) {
    throw new HttpError(400, 'Invalid date format');
  }

  // Time range trong ngày
  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  // Lọc connector theo station + trạng thái IDLE (+ loại nếu có)
  const connectorFilter = { stationId, status: 'IDLE' };
  if (connectorType) connectorFilter.type = connectorType;

  const connectors = await Connector.find(connectorFilter)
    .populate('stationId', 'name lat lng status')
    .lean();

  if (connectors.length === 0) {
    return res.json({
      message: 'No available connectors found',
      availableSlots: [],
      date: targetDate.toISOString().split('T')[0],
    });
  }

  // Bookings active trong ngày
  const existingBookings = await Booking.find({
    stationId,
    status: { $in: [BOOKING_STATUS.RESERVED, BOOKING_STATUS.CHECKED_IN] },
    slotStart: { $gte: startOfDay, $lte: endOfDay },
  }).lean();

  // Sinh slots mỗi 30'
  const slots = [];
  const slotStartHour = 6; // 6 AM
  const slotEndHour = 22; // 10 PM

  for (let hour = slotStartHour; hour < slotEndHour; hour++) {
    for (let minute = 0; minute < 60; minute += 30) {
      const slotStart = new Date(targetDate);
      slotStart.setHours(hour, minute, 0, 0);

      if (slotStart < new Date()) continue;

      const slotEnd = new Date(slotStart);
      slotEnd.setMinutes(slotEnd.getMinutes() + Number(duration || BOOKING_SLOT_MINUTES));

      const availableConnectors = [];

      for (const connector of connectors) {
        const hasOverlap = existingBookings.some((b) => {
          return (
            b.connectorId.toString() === connector._id.toString() &&
            b.slotStart < slotEnd &&
            new Date(b.slotEnd) > slotStart
          );
        });

        if (!hasOverlap) {
          const tariff = await Tariff.findEffectiveAt(stationId, connector.type, slotStart);

          availableConnectors.push({
            connectorId: connector._id,
            connectorCode: connector.code,
            type: connector.type,
            powerKw: connector.powerKw,
            pricing: tariff
              ? {
                  pricePerMin: tariff.pricePerMin,
                  pricePerKwh: tariff.pricePerKwh,
                  idleFeePerMin: tariff.idleFeePerMin,
                  currency: 'VND',
                  mode: tariff.mode,
                }
              : null,
          });
        }
      }

      if (availableConnectors.length > 0) {
        slots.push({
          slotStart: slotStart.toISOString(),
          slotEnd: slotEnd.toISOString(),
          duration: Number(duration || BOOKING_SLOT_MINUTES),
          availableConnectors,
          station: {
            id: connectors[0].stationId._id,
            name: connectors[0].stationId.name,
            lat: connectors[0].stationId.lat,
            lng: connectors[0].stationId.lng,
            status: connectors[0].stationId.status,
          },
        });
      }
    }
  }

  res.json({
    message: 'Available slots retrieved successfully',
    date: targetDate.toISOString().split('T')[0],
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

    const detailed = await populateBookingDetails(refreshed);
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
