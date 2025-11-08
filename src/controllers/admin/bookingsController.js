const mongoose = require('mongoose');
const Booking = require('../../models/Booking');
const Connector = require('../../models/Connector');
const Session = require('../../models/Session');
const asyncHandler = require('../../utils/asyncHandler');
const { HttpError } = require('../../utils/errors');
const { BOOKING_STATUS, SESSION_STATUS } = require('../../constants/enums');
const { formatBookingDates } = require('../../utils/timezoneHelpers');
const bookingMonitor = require('../../services/bookingMonitor');
const { cancelNoShowJob } = require('../../services/bookingScheduler');
const { completeSessionByReference } = require('../../services/sessionFinalizer');

const STATUS_SET = new Set(Object.values(BOOKING_STATUS));

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
  const tokens = String(raw)
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean);
  return tokens.filter((token) => STATUS_SET.has(token));
};

const parseSort = (raw) => {
  const defaultSort = { slotStart: -1 };
  if (!raw) return defaultSort;

  const fields = String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (fields.length === 0) {
    return defaultSort;
  }

  const allowed = new Set([
    'slotStart',
    'slotEnd',
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
          id: station._id ? station._id.toString() : null,
          name: station.name,
          code: station.code,
          status: station.status,
          address: station.address,
          province: station.province,
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

  if (booking._id) {
    booking._id = booking._id.toString();
  }
  if (booking.stationId && booking.stationId.toString) {
    booking.stationId = booking.stationId.toString();
  }
  if (booking.connectorId && booking.connectorId.toString) {
    booking.connectorId = booking.connectorId.toString();
  }
  booking.isPaid = Boolean(booking.isPaid);
  return booking;
};

exports.listBookings = asyncHandler(async (req, res) => {
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
    match.slotStart = {};
    if (startDate) {
      match.slotStart.$gte = startDate;
    }
    if (endDate) {
      match.slotStart.$lte = endDate;
    }
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
  const items = (result?.items || []).map((doc) => shapeBooking(doc));

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

const findBookingByParam = async (param) => {
  const query = { $or: [{ id: param }] };
  if (mongoose.Types.ObjectId.isValid(param)) {
    query.$or.push({ _id: new mongoose.Types.ObjectId(param) });
  }
  return Booking.findOne(query);
};

const populateBookingDetails = async (booking) => {
  if (!booking) return null;

  const aggregateResult = await Booking.aggregate([
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

  return aggregateResult.length > 0 ? shapeBooking(aggregateResult[0]) : null;
};

exports.getBooking = asyncHandler(async (req, res) => {
  const booking = await findBookingByParam(req.params.id);
  if (!booking) {
    throw new HttpError(404, 'Booking not found');
  }

  const detailed = await populateBookingDetails(booking);
  res.json({ booking: detailed });
});

exports.updateBookingStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!status) {
    throw new HttpError(400, 'status is required');
  }

  const normalizedStatus = String(status).toUpperCase();
  if (!STATUS_SET.has(normalizedStatus)) {
    throw new HttpError(400, 'Unsupported booking status');
  }

  const booking = await findBookingByParam(req.params.id);
  if (!booking) {
    throw new HttpError(404, 'Booking not found');
  }

  if (booking.status === normalizedStatus) {
    const detailed = await populateBookingDetails(booking);
    return res.json({
      message: 'Booking already in requested status',
      booking: detailed,
    });
  }

  if (
    normalizedStatus === BOOKING_STATUS.CANCELLED ||
    normalizedStatus === BOOKING_STATUS.NO_SHOW
  ) {
    const allowedSources = [BOOKING_STATUS.RESERVED, BOOKING_STATUS.CHECKED_IN];
    if (!allowedSources.includes(booking.status)) {
      throw new HttpError(
        409,
        `Cannot transition booking from ${booking.status} to ${normalizedStatus}`
      );
    }

    const activeSession = await Session.findOne({
      bookingId: booking._id,
      status: { $in: [SESSION_STATUS.PENDING, SESSION_STATUS.CHARGING] },
    });
    if (activeSession) {
      throw new HttpError(
        409,
        'Booking has an active session. Stop the charging session first.'
      );
    }

    booking.status = normalizedStatus;
    await booking.save();
    bookingMonitor.syncBooking(booking);
    cancelNoShowJob(booking._id);

    await Connector.findOneAndUpdate(
      {
        _id: booking.connectorId,
        status: { $in: ['RESERVED', 'FINISHED'] },
      },
      { $set: { status: 'IDLE' } }
    );

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
    const detailed = await populateBookingDetails(refreshed);

    return res.json({
      message: 'Booking marked as completed',
      booking: detailed,
    });
  }

  throw new HttpError(400, 'Only CANCELLED, NO_SHOW or COMPLETED transitions are supported via this endpoint');
});