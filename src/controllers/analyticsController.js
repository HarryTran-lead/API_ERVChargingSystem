// controllers/analyticsController.js

const mongoose = require('mongoose');

const Session = require('../models/Session');
const Invoice = require('../models/Invoice');
const Station = require('../models/Station');
const Connector = require('../models/Connector');
const Booking = require('../models/Booking');
const User = require('../models/User');
const Feedback = require('../models/Feedback');

const {
  ROLES,
  STATION_STATUS,
  CONNECTOR_STATUS,
  BOOKING_STATUS_VALUES,
  SESSION_STATUS_VALUES,
  BOOKING_STATUS,
  SESSION_STATUS,
} = require('../constants/enums');

const { ensureRequestUserId } = require('../utils/requestUser');
const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../utils/errors');

/* ======================== Helpers gốc ======================== */
const toArray = (v) =>
  Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : [];

const buildCountMap = (rows, defaults = []) => {
  const result = {};
  toArray(defaults).forEach((key) => {
    result[key] = 0;
  });
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!row || row._id === undefined || row._id === null) continue;
      result[row._id] = row.count || 0;
    }
  }
  return result;
};

const buildConnectorMap = (rows, defaults = []) => {
  const result = {};
  toArray(defaults).forEach((key) => {
    result[key] = { count: 0, totalPowerKw: 0 };
  });
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!row || row._id === undefined || row._id === null) continue;
      result[row._id] = {
        count: row.count || 0,
        totalPowerKw: row.totalPowerKw || 0,
      };
    }
  }
  return result;
};

const getFacetCount = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const [first] = rows;
  return first && typeof first.count === 'number' ? first.count : 0;
};

const getFacetMetrics = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { revenue: 0, energyKwh: 0, sessions: 0 };
  }
  const [first] = rows;
  return {
    revenue: first?.revenue || 0,
    energyKwh: first?.energyKwh || 0,
    sessions: first?.sessions || 0,
  };
};

const getFacetRevenue = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { total: 0, count: 0, currency: 'VND' };
  }
  const [first] = rows;
  return {
    total: first?.total || 0,
    count: first?.count || 0,
    currency: first?.currency || 'VND',
  };
};

const monthKey = (year, month) => `${year}-${String(month).padStart(2, '0')}`;

const buildMonthBuckets = (now, monthsBack) => {
  const buckets = [];
  const current = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (let offset = monthsBack - 1; offset >= 0; offset -= 1) {
    const d = new Date(
      Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - offset, 1)
    );
    buckets.push({
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      label: monthKey(d.getUTCFullYear(), d.getUTCMonth() + 1),
    });
  }
  return buckets;
};

/* ======================== Helpers mới cho range ======================== */
const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);

const addDays = (d, days) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
const addMonths = (d, months) => new Date(d.getFullYear(), d.getMonth() + months, 1);

const buildDayBuckets = (from, toExclusive) => {
  const buckets = [];
  let cur = startOfDay(from);
  const end = startOfDay(toExclusive);
  while (cur < end) {
    buckets.push({ label: dayKey(cur), date: new Date(cur) });
    cur = addDays(cur, 1);
  }
  return buckets;
};

const buildMonthBucketsRange = (from, toExclusive) => {
  const buckets = [];
  let cur = new Date(from.getFullYear(), from.getMonth(), 1);
  const end = new Date(toExclusive.getFullYear(), toExclusive.getMonth(), 1);
  while (cur < end) {
    const y = cur.getFullYear();
    const m = cur.getMonth() + 1;
    buckets.push({ label: `${y}-${pad2(m)}`, year: y, month: m });
    cur = addMonths(cur, 1);
  }
  return buckets;
};

const RANGE_PRESETS = {
  '1d': { type: 'day', days: 1 },
  '7d': { type: 'day', days: 7 },
  '1m': { type: 'day', months: 1 }, // day-level trong 1 tháng
  '3m': { type: 'month', months: 3 },
  '6m': { type: 'month', months: 6 },
  '12m': { type: 'month', months: 12 },
};

// Trả về from/to (to là exclusive), đơn vị unit ("day"|"month") & key
function resolveWindow(rangeRaw, yearRaw, endRaw) {
  const now = new Date();
  const rangeKey = (rangeRaw || '6m').toLowerCase();
  const preset = RANGE_PRESETS[rangeKey] || RANGE_PRESETS['6m'];

  let to = endRaw ? new Date(endRaw) : now;

  // Nếu 12m + year => cả năm
  if (preset.months === 12 && Number.isFinite(Number(yearRaw))) {
    const y = Number(yearRaw);
    const from = new Date(y, 0, 1);
    const toExclusive = new Date(y + 1, 0, 1);
    return { from, to: toExclusive, unit: 'month', rangeKey };
  }

  // Nếu có year nhưng không phải 12m => neo to = 01/01/(y+1)
  if (Number.isFinite(Number(yearRaw))) {
    const y = Number(yearRaw);
    to = new Date(y + 1, 0, 1); // exclusive
  }

  let from, unit;
  if (preset.type === 'day') {
    unit = 'day';
    if (preset.days === 1) {
      const endDay = startOfDay(to);
      from = endDay;
      to = endOfDay(endDay);
    } else if (preset.days === 7) {
      const endDay = startOfDay(to);
      to = endOfDay(endDay);
      from = addDays(endDay, -6); // 7 ngày gồm hôm nay
    } else if (preset.months === 1) {
      const curMonthStart = new Date(to.getFullYear(), to.getMonth(), 1);
      const nextMonthStart = new Date(to.getFullYear(), to.getMonth() + 1, 1);
      from = curMonthStart;
      to = nextMonthStart;
    }
  } else {
    unit = 'month';
    const lastMonthStart = new Date(to.getFullYear(), to.getMonth(), 1);
    from = new Date(lastMonthStart.getFullYear(), lastMonthStart.getMonth() - (preset.months - 1), 1);
    to = new Date(lastMonthStart.getFullYear(), lastMonthStart.getMonth() + 1, 1);
  }

  return { from, to, unit, rangeKey };
}

/* ========== GET /api/v1/analytics/me/monthly-costs?year=2025 ========== */
exports.getMyMonthlyCosts = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const year = Number(req.query.year) || new Date().getFullYear();

  const start = new Date(Date.UTC(year, 0, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0));

  // Prefer invoices if available; fallback to session.billing.totalAmount
  const [invoicesAgg, sessionsAgg] = await Promise.all([
    Invoice.aggregate([
      {
        $match: {
          $and: [
            { createdAt: { $gte: start, $lt: end } },
            { status: 'ISSUED' },
            { $or: [{ userId }, { user_id: userId }] }, // hỗ trợ cả hai field
          ],
        },
      },
      {
        $group: {
          _id: { $month: '$createdAt' },
          total: { $sum: { $ifNull: ['$total', 0] } },
          count: { $sum: 1 },
          currency: { $first: { $ifNull: ['$currency', 'VND'] } },
        },
      },
    ]),
    Session.aggregate([
      {
        $match: {
          userId,
          createdAt: { $gte: start, $lt: end },
          status: 'COMPLETED',
        },
      },
      {
        $group: {
          _id: { $month: '$createdAt' },
          total: { $sum: { $ifNull: ['$billing.totalAmount', 0] } },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const useInvoices = Array.isArray(invoicesAgg) && invoicesAgg.length > 0;
  const sourceRows = useInvoices ? invoicesAgg : sessionsAgg;

  const byMonth = new Array(12)
    .fill(0)
    .map((_, i) => ({ month: i + 1, amount: 0, sessions: 0 }));

  for (const row of sourceRows) {
    const idx = Math.max(1, Math.min(12, row._id)) - 1;
    byMonth[idx].amount = row.total || 0;
    byMonth[idx].sessions = row.count || 0;
  }

  const currency = useInvoices ? invoicesAgg?.[0]?.currency || 'VND' : 'VND';
  const grandTotal = byMonth.reduce((s, m) => s + (m.amount || 0), 0);

  return res.json({
    year,
    currency,
    grandTotal,
    months: byMonth,
  });
});

/* ========== GET /api/v1/analytics/me/habits?from=ISO&to=ISO ========== */
exports.getMyChargingHabits = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from
    ? new Date(req.query.from)
    : new Date(to.getFullYear(), to.getMonth() - 2, to.getDate());

  const sessions = await Session.aggregate([
    {
      $match: {
        userId,
        status: 'COMPLETED',
        createdAt: { $gte: from, $lte: to },
      },
    },
    {
      $project: {
        stationId: 1,
        connectorId: 1,
        startedAt: 1,
        stoppedAt: 1,
        energyKwh: '$billing.breakdown.energyKwh',
        totalAmount: '$billing.totalAmount',
      },
    },
  ]);

  const stationIds = [...new Set(sessions.map((s) => s.stationId).filter(Boolean))];
  const connectorIds = [...new Set(sessions.map((s) => s.connectorId).filter(Boolean))];

  const [stations, connectors] = await Promise.all([
    stationIds.length
      ? Station.find({ _id: { $in: stationIds } })
          .select('_id name lat lng')
          .lean()
      : [],
    connectorIds.length
      ? Connector.find({ _id: { $in: connectorIds } })
          .select('_id powerKw type')
          .lean()
      : [],
  ]);

  const stationMap = Object.fromEntries(stations.map((s) => [String(s._id), s]));
  const connectorMap = Object.fromEntries(connectors.map((c) => [String(c._id), c]));

  const byStation = {};
  const byHour = new Array(24).fill(0);
  const powerBuckets = {
    '<=7kW': 0,
    '7-22kW': 0,
    '22-50kW': 0,
    '50-150kW': 0,
    '>150kW': 0,
  };

  for (const s of sessions) {
    const stKey = String(s.stationId);
    if (!byStation[stKey]) {
      const meta = stationMap[stKey] || {};
      byStation[stKey] = {
        stationId: stKey,
        name: meta.name || null,
        lat: meta.lat,
        lng: meta.lng,
        sessions: 0,
        energyKwh: 0,
        amount: 0,
      };
    }
    byStation[stKey].sessions += 1;
    byStation[stKey].energyKwh += Number(s.energyKwh || 0);
    byStation[stKey].amount += Number(s.totalAmount || 0);

    const start = s.startedAt ? new Date(s.startedAt) : null;
    if (start) {
      const hour = start.getHours();
      if (hour >= 0 && hour <= 23) byHour[hour] += 1;
    }

    const conn = connectorMap[String(s.connectorId)];
    const power = conn?.powerKw;
    if (Number.isFinite(power)) {
      if (power <= 7) powerBuckets['<=7kW'] += 1;
      else if (power <= 22) powerBuckets['7-22kW'] += 1;
      else if (power <= 50) powerBuckets['22-50kW'] += 1;
      else if (power <= 150) powerBuckets['50-150kW'] += 1;
      else powerBuckets['>150kW'] += 1;
    }
  }

  const topStations = Object.values(byStation)
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 5);

  return res.json({
    from,
    to,
    counts: { totalSessions: sessions.length },
    where: { topStations },
    when: { byHour },
    power: { buckets: powerBuckets },
  });
});

/* ========== GET /api/v1/analytics/admin/overview
      ?range=1d|7d|1m|3m|6m|12m&year=YYYY&end=ISO&stationId=ID ========== */
exports.getAdminOverview = asyncHandler(async (req, res) => {
  // --- đọc tham số ---
  const { range, year, end, stationId } = req.query;
  const { from, to, unit, rangeKey } = resolveWindow(range, year, end);

  // Chuẩn hóa & validate stationId: 'all' => bỏ lọc; còn lại phải là ObjectId hợp lệ
  const rawStationId = Array.isArray(stationId) ? stationId[0] : stationId;
  const trimmedStationId =
    typeof rawStationId === 'string' ? rawStationId.trim() : rawStationId;

  let stationObjectId = null;
  if (trimmedStationId) {
    const stationIdLower =
      typeof trimmedStationId === 'string' ? trimmedStationId.toLowerCase() : trimmedStationId;
    if (stationIdLower !== 'all') {
      if (!mongoose.Types.ObjectId.isValid(trimmedStationId)) {
        throw new HttpError(400, 'Invalid stationId');
      }
      stationObjectId = new mongoose.Types.ObjectId(trimmedStationId);
    }
  }

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  // --- facets người dùng / trạm / connector / booking ---
  const userStatsPromise = User.aggregate([
    {
      $facet: {
        byRole: [{ $group: { _id: '$role', count: { $sum: 1 } } }],
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        newInRange: [
          {
            $match: {
              $or: [
                { createdAt: { $gte: from, $lt: to } },
                { created_at: { $gte: from, $lt: to } },
              ],
            },
          },
          { $count: 'count' },
        ],
      },
    },
  ]);

  const stationStatusPipeline = [];
  if (stationObjectId) {
    stationStatusPipeline.push({ $match: { _id: stationObjectId } });
  }
  stationStatusPipeline.push({ $group: { _id: '$status', count: { $sum: 1 } } });
  const stationStatusPromise = Station.aggregate(stationStatusPipeline);

  const connectorStatsPipeline = [];
  if (stationObjectId) {
    connectorStatsPipeline.push({ $match: { stationId: stationObjectId } });
  }
  connectorStatsPipeline.push({
    $facet: {
      byStatus: [
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            totalPowerKw: { $sum: { $ifNull: ['$powerKw', 0] } },
          },
        },
      ],
      byType: [
        {
          $group: {
            _id: '$type',
            count: { $sum: 1 },
            totalPowerKw: { $sum: { $ifNull: ['$powerKw', 0] } },
          },
        },
      ],
    },
  });
  const connectorStatsPromise = Connector.aggregate(connectorStatsPipeline);

  const bookingStatsPipeline = [];
  if (stationObjectId) {
    bookingStatsPipeline.push({ $match: { stationId: stationObjectId } });
  }
  bookingStatsPipeline.push({
    $facet: {
      byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
      upcoming: [
        {
          $match: {
            slotStart: { $gte: now },
            status: { $in: [BOOKING_STATUS.RESERVED, BOOKING_STATUS.CHECKED_IN] },
          },
        },
        { $count: 'count' },
      ],
      today: [
        {
          $match: {
            slotStart: { $gte: startOfToday, $lt: endOfToday },
          },
        },
        { $count: 'count' },
      ],
      inRange: [
        { $match: { slotStart: { $gte: from, $lt: to } } },
        { $count: 'count' },
      ],
    },
  });
  const bookingStatsPromise = Booking.aggregate(bookingStatsPipeline);

  // --- session facets phụ thuộc range & series ---
  const sessionSeriesGroup =
    unit === 'day'
      ? {
          _id: {
            y: { $year: '$createdAt' },
            m: { $month: '$createdAt' },
            d: { $dayOfMonth: '$createdAt' },
          },
          revenue: { $sum: { $ifNull: ['$billing.totalAmount', 0] } },
          energyKwh: { $sum: { $ifNull: ['$billing.breakdown.energyKwh', 0] } },
          sessions: { $sum: 1 },
        }
      : {
          _id: {
            y: { $year: '$createdAt' },
            m: { $month: '$createdAt' },
          },
          revenue: { $sum: { $ifNull: ['$billing.totalAmount', 0] } },
          energyKwh: { $sum: { $ifNull: ['$billing.breakdown.energyKwh', 0] } },
          sessions: { $sum: 1 },
        };

  const sessionStatsPipeline = [];
  if (stationObjectId) {
    sessionStatsPipeline.push({ $match: { stationId: stationObjectId } });
  }
  sessionStatsPipeline.push({
    $facet: {
      byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
      active: [
        {
          $match: {
            status: { $in: [SESSION_STATUS.PENDING, SESSION_STATUS.CHARGING] },
          },
        },
        { $count: 'count' },
      ],
      lifetime: [
        { $match: { status: SESSION_STATUS.COMPLETED } },
        {
          $group: {
            _id: null,
            revenue: { $sum: { $ifNull: ['$billing.totalAmount', 0] } },
            energyKwh: { $sum: { $ifNull: ['$billing.breakdown.energyKwh', 0] } },
            sessions: { $sum: 1 },
          },
        },
      ],
      selectedRange: [
        {
          $match: {
            status: SESSION_STATUS.COMPLETED,
            createdAt: { $gte: from, $lt: to },
          },
        },
        {
          $group: {
            _id: null,
            revenue: { $sum: { $ifNull: ['$billing.totalAmount', 0] } },
            energyKwh: { $sum: { $ifNull: ['$billing.breakdown.energyKwh', 0] } },
            sessions: { $sum: 1 },
          },
        },
      ],
      series: [
        {
          $match: {
            status: SESSION_STATUS.COMPLETED,
            createdAt: { $gte: from, $lt: to },
          },
        },
        { $group: sessionSeriesGroup },
        { $sort: { '_id.y': 1, '_id.m': 1, ...(unit === 'day' ? { '_id.d': 1 } : {}) } },
      ],
      topStations: [
        {
          $match: {
            status: SESSION_STATUS.COMPLETED,
            createdAt: { $gte: from, $lt: to },
          },
        },
        {
          $group: {
            _id: '$stationId',
            revenue: { $sum: { $ifNull: ['$billing.totalAmount', 0] } },
            energyKwh: { $sum: { $ifNull: ['$billing.breakdown.energyKwh', 0] } },
            sessions: { $sum: 1 },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 5 },
      ],
    },
  });
  const sessionStatsPromise = Session.aggregate(sessionStatsPipeline);

  // --- invoice facets phụ thuộc range & series ---
  const invoiceSeriesGroup =
    unit === 'day'
      ? {
          _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' }, d: { $dayOfMonth: '$createdAt' } },
          total: { $sum: { $ifNull: ['$total', 0] } },
          currency: { $first: { $ifNull: ['$currency', 'VND'] } },
        }
      : {
          _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } },
          total: { $sum: { $ifNull: ['$total', 0] } },
          currency: { $first: { $ifNull: ['$currency', 'VND'] } },
        };

  const invoiceStatsPipeline = [{ $match: { status: 'ISSUED' } }];
  if (stationObjectId) {
    // Lọc hóa đơn theo trạm qua session tương ứng
    invoiceStatsPipeline.push({
      $lookup: {
        from: 'sessions',
        localField: 'session_id', // lưu ý: trường liên kết
        foreignField: 'id',       // session "id" (không phải _id) trong hệ thống
        as: 'sessionDoc',
      },
    });
    invoiceStatsPipeline.push({ $unwind: '$sessionDoc' });
    invoiceStatsPipeline.push({ $match: { 'sessionDoc.stationId': stationObjectId } });
    invoiceStatsPipeline.push({ $project: { sessionDoc: 0 } });
  }
  invoiceStatsPipeline.push({
    $facet: {
      lifetime: [
        {
          $group: {
            _id: null,
            total: { $sum: { $ifNull: ['$total', 0] } },
            count: { $sum: 1 },
            currency: { $first: { $ifNull: ['$currency', 'VND'] } },
          },
        },
      ],
      selectedRange: [
        { $match: { createdAt: { $gte: from, $lt: to } } },
        {
          $group: {
            _id: null,
            total: { $sum: { $ifNull: ['$total', 0] } },
            count: { $sum: 1 },
            currency: { $first: { $ifNull: ['$currency', 'VND'] } },
          },
        },
      ],
      series: [
        { $match: { createdAt: { $gte: from, $lt: to } } },
        { $group: invoiceSeriesGroup },
        { $sort: { '_id.y': 1, '_id.m': 1, ...(unit === 'day' ? { '_id.d': 1 } : {}) } },
      ],
    },
  });
  const invoiceStatsPromise = Invoice.aggregate(invoiceStatsPipeline);

  // --- feedback facets phụ thuộc range ---
  const feedbackStatsPromise = Feedback.aggregate([
    {
      $facet: {
        overall: [
          {
            $group: {
              _id: null,
              averageRating: { $avg: '$rating' },
              total: { $sum: 1 },
            },
          },
        ],
        selectedRange: [
          { $match: { createdAt: { $gte: from, $lt: to } } },
          {
            $group: {
              _id: null,
              averageRating: { $avg: '$rating' },
              total: { $sum: 1 },
            },
          },
        ],
        distribution: [
          {
            $group: {
              _id: '$rating',
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ],
      },
    },
  ]);

  // --- chạy song song ---
  const [
    userStatsResult,
    stationStatusRows,
    connectorStatsResult,
    bookingStatsResult,
    sessionStatsResult,
    invoiceStatsResult,
    feedbackStatsResult,
  ] = await Promise.all([
    userStatsPromise,
    stationStatusPromise,
    connectorStatsPromise,
    bookingStatsPromise,
    sessionStatsPromise,
    invoiceStatsPromise,
    feedbackStatsPromise,
  ]);

  // --- bóc kết quả ---
  const userStats = userStatsResult?.[0] || {};
  const connectorStats = connectorStatsResult?.[0] || {};
  const bookingStats = bookingStatsResult?.[0] || {};
  const sessionStats = sessionStatsResult?.[0] || {};
  const invoiceStats = invoiceStatsResult?.[0] || {};
  const feedbackStats = feedbackStatsResult?.[0] || {};

  const userByRole = buildCountMap(userStats.byRole, toArray(ROLES));
  const userByStatus = buildCountMap(userStats.byStatus, ['ACTIVE', 'SUSPENDED']);
  const totalUsers = Object.values(userByRole).reduce((sum, c) => sum + c, 0);

  const stationByStatus = buildCountMap(stationStatusRows, toArray(STATION_STATUS));
  const totalStations = Object.values(stationByStatus).reduce((s, c) => s + c, 0);

  const connectorsByStatus = buildConnectorMap(connectorStats.byStatus, toArray(CONNECTOR_STATUS));
  const connectorsByType = buildConnectorMap(connectorStats.byType);
  const totalConnectors = Object.values(connectorsByStatus).reduce((s, it) => s + it.count, 0);
  const totalConnectorPowerKw = Object.values(connectorsByStatus).reduce((s, it) => s + it.totalPowerKw, 0);

  const bookingsByStatus = buildCountMap(bookingStats.byStatus, BOOKING_STATUS_VALUES);
  const totalBookings = Object.values(bookingsByStatus).reduce((s, c) => s + c, 0);
  const upcomingBookings = getFacetCount(bookingStats.upcoming);
  const todayBookings = getFacetCount(bookingStats.today);

  const sessionsByStatus = buildCountMap(sessionStats.byStatus, SESSION_STATUS_VALUES);
  const totalSessions = Object.values(sessionsByStatus).reduce((s, c) => s + c, 0);
  const activeSessions = getFacetCount(sessionStats.active);

  const lifetimeCharging = getFacetMetrics(sessionStats.lifetime);
  const selectedRangeCharging = getFacetMetrics(sessionStats.selectedRange);

  const revenueLifetime = getFacetRevenue(invoiceStats.lifetime);
  const revenueSelected = getFacetRevenue(invoiceStats.selectedRange);

  // --- series buckets & map ---
  const seriesBuckets = unit === 'day'
    ? buildDayBuckets(from, to)
    : buildMonthBucketsRange(from, to);

  const chargingSeriesMap = new Map();
  for (const row of sessionStats.series || []) {
    const y = row?._id?.y;
    const m = row?._id?.m;
    const d = unit === 'day' ? row?._id?.d : null;
    const label = unit === 'day' ? `${y}-${pad2(m)}-${pad2(d)}` : `${y}-${pad2(m)}`;
    chargingSeriesMap.set(label, {
      revenue: row?.revenue || 0,
      energyKwh: row?.energyKwh || 0,
      sessions: row?.sessions || 0,
    });
  }

  const revenueSeriesMap = new Map();
  for (const row of (invoiceStats.series || [])) {
    const y = row?._id?.y;
    const m = row?._id?.m;
    const d = unit === 'day' ? row?._id?.d : null;
    const label = unit === 'day' ? `${y}-${pad2(m)}-${pad2(d)}` : `${y}-${pad2(m)}`;
    revenueSeriesMap.set(label, row?.total || 0);
  }

  const revenueSeries = seriesBuckets.map(({ label }) => ({
    bucket: label,
    total: revenueSeriesMap.get(label) || 0,
  }));

  const chargingSeries = seriesBuckets.map(({ label }) => {
    const v = chargingSeriesMap.get(label) || { revenue: 0, energyKwh: 0, sessions: 0 };
    return { bucket: label, ...v };
  });

  // --- top stations trong khoảng chọn ---
  const topStationsRaw = sessionStats.topStations || [];
  const topStationIds = topStationsRaw.map((r) => r?._id).filter(Boolean);
  const stationDocs =
    topStationIds.length > 0
      ? await Station.find({ _id: { $in: topStationIds } })
          .select('_id name lat lng status')
          .lean()
      : [];
  const stationMeta = new Map(stationDocs.map((doc) => [String(doc._id), doc]));
  const topStations = topStationsRaw.map((row) => {
    const id = row?._id ? String(row._id) : null;
    const meta = id ? stationMeta.get(id) : null;
    return {
      stationId: id,
      name: meta?.name || null,
      status: meta?.status || null,
      lat: meta?.lat ?? null,
      lng: meta?.lng ?? null,
      revenue: row?.revenue || 0,
      energyKwh: row?.energyKwh || 0,
      sessions: row?.sessions || 0,
    };
  });

  const overallFeedback = feedbackStats.overall?.[0] || null;
  const inRangeFeedback = feedbackStats.selectedRange?.[0] || null;
  const feedbackDistribution = buildCountMap(feedbackStats.distribution || [], [1, 2, 3, 4, 5]);

  const roundRating = (value) =>
    typeof value === 'number' ? Math.round(value * 100) / 100 : null;

  // --- response ---
  return res.json({
    generatedAt: now.toISOString(),
    range: {
      key: rangeKey,         // "1d" | "7d" | "1m" | "3m" | "6m" | "12m"
      unit,                  // "day" | "month"
      from,                  // inclusive
      to,                    // exclusive
      year: Number.isFinite(Number(year)) ? Number(year) : null,
    },
    totals: {
      users: {
        total: totalUsers,
        byRole: userByRole,
        byStatus: userByStatus,
        active: userByStatus.ACTIVE || 0,
        suspended: userByStatus.SUSPENDED || 0,
        newInRange: getFacetCount(userStats.newInRange),
      },
      stations: {
        total: totalStations,
        byStatus: stationByStatus,
      },
      connectors: {
        total: totalConnectors,
        totalPowerKw: totalConnectorPowerKw,
        byStatus: connectorsByStatus,
        byType: connectorsByType,
      },
      bookings: {
        total: totalBookings,
        byStatus: bookingsByStatus,
        upcoming: upcomingBookings,
        today: todayBookings,
        inRange: getFacetCount(bookingStats.inRange),
      },
      sessions: {
        total: totalSessions,
        byStatus: sessionsByStatus,
        active: activeSessions,
      },
    },
    revenue: {
      currency: revenueLifetime.currency || 'VND',
      lifetime: revenueLifetime,
      selectedRange: revenueSelected,
      series: { unit, points: revenueSeries }, // [{bucket, total}]
    },
    charging: {
      lifetime: lifetimeCharging,
      selectedRange: selectedRangeCharging,
      series: { unit, points: chargingSeries }, // [{bucket, revenue, energyKwh, sessions}]
      topStationsInRange: topStations,
    },
    feedback: {
      total: overallFeedback?.total || 0,
      averageRating: roundRating(overallFeedback?.averageRating),
      selectedRange: {
        total: inRangeFeedback?.total || 0,
        averageRating: roundRating(inRangeFeedback?.averageRating),
      },
      distribution: feedbackDistribution,
    },
  });
});
