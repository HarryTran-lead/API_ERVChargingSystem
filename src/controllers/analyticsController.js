// controllers/analyticsController.js

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

// ------- helpers -------
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

// ========== GET /api/v1/analytics/me/monthly-costs?year=2025 ==========
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

// ========== GET /api/v1/analytics/me/habits?from=ISO&to=ISO ==========
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

// ========== GET /api/v1/analytics/admin/overview ==========
exports.getAdminOverview = asyncHandler(async (req, res) => {
  const now = new Date();
  const last30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
  const monthsBack = 6;
  const sixMonthsAgo = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (monthsBack - 1), 1)
  );

  const userStatsPromise = User.aggregate([
    {
      $facet: {
        byRole: [{ $group: { _id: '$role', count: { $sum: 1 } } }],
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        newLast30Days: [
          {
            $match: {
              $or: [
                { createdAt: { $gte: last30Days } },
                { created_at: { $gte: last30Days } }, // hỗ trợ hai kiểu
              ],
            },
          },
          { $count: 'count' },
        ],
      },
    },
  ]);

  const stationStatusPromise = Station.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const connectorStatsPromise = Connector.aggregate([
    {
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
    },
  ]);

  const bookingStatsPromise = Booking.aggregate([
    {
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
      },
    },
  ]);

  const sessionStatsPromise = Session.aggregate([
    {
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
        last30Days: [
          {
            $match: {
              status: SESSION_STATUS.COMPLETED,
              createdAt: { $gte: last30Days },
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
        monthly: [
          {
            $match: {
              status: SESSION_STATUS.COMPLETED,
              createdAt: { $gte: sixMonthsAgo },
            },
          },
          {
            $group: {
              _id: {
                year: { $year: '$createdAt' },
                month: { $month: '$createdAt' },
              },
              revenue: { $sum: { $ifNull: ['$billing.totalAmount', 0] } },
              energyKwh: { $sum: { $ifNull: ['$billing.breakdown.energyKwh', 0] } },
              sessions: { $sum: 1 },
            },
          },
          { $sort: { '_id.year': 1, '_id.month': 1 } },
        ],
        topStations: [
          {
            $match: {
              status: SESSION_STATUS.COMPLETED,
              createdAt: { $gte: last30Days },
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
    },
  ]);

  const invoiceStatsPromise = Invoice.aggregate([
    { $match: { status: 'ISSUED' } },
    {
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
        last30Days: [
          { $match: { createdAt: { $gte: last30Days } } },
          {
            $group: {
              _id: null,
              total: { $sum: { $ifNull: ['$total', 0] } },
              count: { $sum: 1 },
              currency: { $first: { $ifNull: ['$currency', 'VND'] } },
            },
          },
        ],
        monthly: [
          { $match: { createdAt: { $gte: sixMonthsAgo } } },
          {
            $group: {
              _id: {
                year: { $year: '$createdAt' },
                month: { $month: '$createdAt' },
              },
              total: { $sum: { $ifNull: ['$total', 0] } },
              currency: { $first: { $ifNull: ['$currency', 'VND'] } },
            },
          },
          { $sort: { '_id.year': 1, '_id.month': 1 } },
        ],
      },
    },
  ]);

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
        last30Days: [
          { $match: { createdAt: { $gte: last30Days } } },
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

  const userStats = userStatsResult?.[0] || {};
  const connectorStats = connectorStatsResult?.[0] || {};
  const bookingStats = bookingStatsResult?.[0] || {};
  const sessionStats = sessionStatsResult?.[0] || {};
  const invoiceStats = invoiceStatsResult?.[0] || {};
  const feedbackStats = feedbackStatsResult?.[0] || {};

  const userByRole = buildCountMap(userStats.byRole, toArray(ROLES));
  const userByStatus = buildCountMap(userStats.byStatus, ['ACTIVE', 'SUSPENDED']);
  const totalUsers = Object.values(userByRole).reduce((sum, count) => sum + count, 0);

  const stationByStatus = buildCountMap(stationStatusRows, toArray(STATION_STATUS));
  const totalStations = Object.values(stationByStatus).reduce((sum, count) => sum + count, 0);

  const connectorsByStatus = buildConnectorMap(connectorStats.byStatus, toArray(CONNECTOR_STATUS));
  const connectorsByType = buildConnectorMap(connectorStats.byType);
  const totalConnectors = Object.values(connectorsByStatus).reduce((sum, item) => sum + item.count, 0);
  const totalConnectorPowerKw = Object.values(connectorsByStatus).reduce(
    (sum, item) => sum + item.totalPowerKw,
    0
  );

  const bookingsByStatus = buildCountMap(bookingStats.byStatus, BOOKING_STATUS_VALUES);
  const totalBookings = Object.values(bookingsByStatus).reduce((sum, count) => sum + count, 0);
  const upcomingBookings = getFacetCount(bookingStats.upcoming);
  const todayBookings = getFacetCount(bookingStats.today);

  const sessionsByStatus = buildCountMap(sessionStats.byStatus, SESSION_STATUS_VALUES);
  const totalSessions = Object.values(sessionsByStatus).reduce((sum, count) => sum + count, 0);
  const activeSessions = getFacetCount(sessionStats.active);

  const lifetimeCharging = getFacetMetrics(sessionStats.lifetime);
  const last30Charging = getFacetMetrics(sessionStats.last30Days);

  const revenueLifetime = getFacetRevenue(invoiceStats.lifetime);
  const revenueLast30 = getFacetRevenue(invoiceStats.last30Days);

  const monthBuckets = buildMonthBuckets(now, monthsBack);

  const revenueMonthlyMap = new Map();
  for (const row of invoiceStats.monthly || []) {
    if (!row || !row._id) continue;
    revenueMonthlyMap.set(monthKey(row._id.year, row._id.month), row.total || 0);
  }

  const chargingMonthlyMap = new Map();
  for (const row of sessionStats.monthly || []) {
    if (!row || !row._id) continue;
    chargingMonthlyMap.set(monthKey(row._id.year, row._id.month), {
      revenue: row.revenue || 0,
      energyKwh: row.energyKwh || 0,
      sessions: row.sessions || 0,
    });
  }

  const revenueMonthly = monthBuckets.map(({ label }) => ({
    month: label,
    total: revenueMonthlyMap.get(label) || 0,
  }));

  const chargingMonthly = monthBuckets.map(({ label }) => {
    const item = chargingMonthlyMap.get(label) || {
      revenue: 0,
      energyKwh: 0,
      sessions: 0,
    };
    return {
      month: label,
      revenue: item.revenue,
      energyKwh: item.energyKwh,
      sessions: item.sessions,
    };
  });

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
  const last30Feedback = feedbackStats.last30Days?.[0] || null;
  const feedbackDistribution = buildCountMap(feedbackStats.distribution || [], [1, 2, 3, 4, 5]);

  const roundRating = (value) =>
    typeof value === 'number' ? Math.round(value * 100) / 100 : null;

  return res.json({
    generatedAt: now.toISOString(),
    totals: {
      users: {
        total: totalUsers,
        byRole: userByRole,
        byStatus: userByStatus,
        active: userByStatus.ACTIVE || 0,
        suspended: userByStatus.SUSPENDED || 0,
        newLast30Days: getFacetCount(userStats.newLast30Days),
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
      last30Days: revenueLast30,
      monthly: revenueMonthly,
    },
    charging: {
      lifetime: lifetimeCharging,
      last30Days: last30Charging,
      monthly: chargingMonthly,
      topStationsLast30Days: topStations,
    },
    feedback: {
      total: overallFeedback?.total || 0,
      averageRating: roundRating(overallFeedback?.averageRating),
      last30Days: {
        total: last30Feedback?.total || 0,
        averageRating: roundRating(last30Feedback?.averageRating),
      },
      distribution: feedbackDistribution,
    },
  });
});
