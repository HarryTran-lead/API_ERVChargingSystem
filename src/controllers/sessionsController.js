const mongoose = require('mongoose');
const Session = require('../models/Session');
const Booking = require('../models/Booking');
const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../utils/errors');
const { SESSION_STATUS, BOOKING_STATUS } = require('../constants/enums');
const { formatSessionDates, formatToVietnamTime } = require('../utils/timezoneHelpers');
const { completeSession } = require('../services/sessionFinalizer');
const { finalizeSessionBroadcast } = require('../services/chargingMonitor');
const bookingMonitor = require('../services/bookingMonitor');
const { safeNotifyUser } = require('../services/notificationService');

const STATUS_SET = new Set(Object.values(SESSION_STATUS));

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

const parseStatuses = (raw) => {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter((token) => STATUS_SET.has(token));
};

const parseSort = (raw) => {
  const defaultSort = { startedAt: -1 };
  if (!raw) return defaultSort;

  const fields = String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (fields.length === 0) {
    return defaultSort;
  }

  const allowed = new Set([
    'startedAt',
    'stoppedAt',
    'createdAt',
    'updatedAt',
  ]);

  const sortSpec = {};
  fields.forEach((field) => {
    let direction = 1;
    let name = field;
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

const toPlain = (value) =>
  value && typeof value.toObject === 'function' ? value.toObject() : value;

const baseSessionPayload = (sessionDoc) => {
  const session = formatSessionDates(toPlain(sessionDoc));

  return {
    _id: session._id ? session._id.toString() : undefined,
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
    chargingPredictions:
      session.chargingPredictions || {
        chargePercentageIn30Min: 0,
        timeToFullChargeMinutes: null,
        energyChargedKwh: 0,
        energyRemainingKwh: 0,
      },
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
};

const notifySessionStoppedByAdmin = async (session) => {
  if (!session?.userId) {
    return;
  }

  await safeNotifyUser({
    userId: session.userId,
    title: 'Charging session stopped by admin',
    body: `Your charging session ${session.id} was stopped by an administrator at ${
      formatToVietnamTime(session.stoppedAt) || formatToVietnamTime(new Date())
    }.`,
    type: 'session',
    data: {
      sessionId: session.id,
      bookingId: session.bookingRef || session.bookingId?.toString?.() || null,
      status: session.status,
      stoppedAt: formatToVietnamTime(session.stoppedAt),
    },
  });
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
          id: station._id ? station._id.toString() : null,
          name: station.name,
          code: station.code,
          status: station.status,
        }
      : null,
    connector: connector
      ? {
          id: connector._id ? connector._id.toString() : null,
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

  const statuses = parseStatuses(status);
  const match = {};
  if (statuses.length > 0) {
    match.status = { $in: statuses };
  }
  if (userId) {
    match.userId = userId;
  }
  const stationObjectId = toObjectId(stationId);
  if (stationObjectId) {
    match.stationId = stationObjectId;
  }
  const connectorObjectId = toObjectId(connectorId);
  if (connectorObjectId) {
    match.connectorId = connectorObjectId;
  }

  const startDate = parseDate(from);
  const endDate = parseDate(to);
  if (startDate || endDate) {
    match.startedAt = {};
    if (startDate) {
      match.startedAt.$gte = startDate;
    }
    if (endDate) {
      match.startedAt.$lte = endDate;
    }
  }

  if (search) {
    const keyword = String(search).trim();
    if (keyword) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      const orConditions = [
        { id: keyword },
        { bookingRef: keyword },
        { userId: keyword },
        { 'billing.currency': keyword },
        { id: { $regex: regex } },
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
              from: 'bookings',
              localField: 'bookingId',
              foreignField: '_id',
              as: 'booking',
            },
          },
          { $unwind: { path: '$booking', preserveNullAndEmptyArrays: true } },
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

  const [result] = await Session.aggregate(pipeline);
  const total = result?.total || 0;
  const items = (result?.items || []).map((doc) => shapeSession(doc));

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

const findSessionByParam = async (param) => {
  const query = { $or: [{ id: param }] };
  if (mongoose.Types.ObjectId.isValid(param)) {
    query.$or.push({ _id: new mongoose.Types.ObjectId(param) });
  }
  return Session.findOne(query);
};

const populateSessionDetails = async (session) => {
  if (!session) return null;

  const result = await Session.aggregate([
    { $match: { _id: session._id } },
    {
      $lookup: {
        from: 'bookings',
        localField: 'bookingId',
        foreignField: '_id',
        as: 'booking',
      },
    },
    { $unwind: { path: '$booking', preserveNullAndEmptyArrays: true } },
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
  ]);

  return result.length > 0 ? shapeSession(result[0]) : null;
};

exports.getSession = asyncHandler(async (req, res) => {
  const session = await findSessionByParam(req.params.id);
  if (!session) {
    throw new HttpError(404, 'Session not found');
  }

  const detailed = await populateSessionDetails(session);
  res.json({ session: detailed });
});

exports.stopSession = asyncHandler(async (req, res) => {
  const session = await findSessionByParam(req.params.id);
  if (!session) {
    throw new HttpError(404, 'Session not found');
  }

  const stoppable = [SESSION_STATUS.CHARGING, SESSION_STATUS.COMPLETED];
  if (!stoppable.includes(session.status)) {
    throw new HttpError(409, 'Session cannot be stopped in its current state');
  }
  if (!session.startedAt) {
    throw new HttpError(500, 'Session start timestamp is missing');
  }

  const finalized = await completeSession(session, { stoppedAt: new Date() });
  if (!finalized) {
    throw new HttpError(500, 'Failed to finalize the session');
  }

  const broadcastPayload = baseSessionPayload(finalized);
  finalizeSessionBroadcast(broadcastPayload);

  if (finalized.bookingId) {
    const booking = await Booking.findById(finalized.bookingId);
    if (booking && booking.status !== BOOKING_STATUS.COMPLETED) {
      booking.status = BOOKING_STATUS.COMPLETED;
      await booking.save();
      bookingMonitor.syncBooking(booking);
    }
  }

  const detailed = (await populateSessionDetails(finalized)) || broadcastPayload;
  await notifySessionStoppedByAdmin(finalized);

  res.json({
    message: 'Session stopped successfully',
    session: detailed,
  });
});