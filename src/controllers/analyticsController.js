const Session = require("../models/Session");
const Invoice = require("../models/Invoice");
const Station = require("../models/Station");
const Connector = require("../models/Connector");
const { ensureRequestUserId } = require("../utils/requestUser");
const asyncHandler = require("../utils/asyncHandler");

// GET /api/v1/analytics/me/monthly-costs?year=2025
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
          user_id: userId,
          createdAt: { $gte: start, $lt: end },
          status: "ISSUED",
        },
      },
      {
        $group: {
          _id: { $month: "$createdAt" },
          total: { $sum: "$total" },
          count: { $sum: 1 },
        },
      },
    ]),
    Session.aggregate([
      {
        $match: {
          userId,
          createdAt: { $gte: start, $lt: end },
          status: "COMPLETED",
        },
      },
      {
        $group: {
          _id: { $month: "$createdAt" },
          total: { $sum: "$billing.totalAmount" },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const byMonth = new Array(12)
    .fill(0)
    .map((_, i) => ({ month: i + 1, amount: 0, sessions: 0 }));
  const src = invoicesAgg && invoicesAgg.length ? invoicesAgg : sessionsAgg;
  for (const row of src) {
    const idx = Math.max(1, Math.min(12, row._id)) - 1;
    byMonth[idx].amount = row.total || 0;
    byMonth[idx].sessions = row.count || 0;
  }

  const currency = "VND";
  const grandTotal = byMonth.reduce((s, m) => s + (m.amount || 0), 0);
  return res.json({ year, currency, grandTotal, months: byMonth });
});

// GET /api/v1/analytics/me/habits?from=ISO&to=ISO
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
        status: "COMPLETED",
        createdAt: { $gte: from, $lte: to },
      },
    },
    {
      $project: {
        stationId: 1,
        connectorId: 1,
        startedAt: 1,
        stoppedAt: 1,
        energyKwh: "$billing.breakdown.energyKwh",
        totalAmount: "$billing.totalAmount",
      },
    },
  ]);

  const stationIds = [
    ...new Set(sessions.map((s) => s.stationId).filter(Boolean)),
  ];
  const connectorIds = [
    ...new Set(sessions.map((s) => s.connectorId).filter(Boolean)),
  ];
  const [stations, connectors] = await Promise.all([
    stationIds.length
      ? Station.find({ _id: { $in: stationIds } })
          .select("_id name lat lng")
          .lean()
      : [],
    connectorIds.length
      ? Connector.find({ _id: { $in: connectorIds } })
          .select("_id powerKw type")
          .lean()
      : [],
  ]);
  const stationMap = Object.fromEntries(
    stations.map((s) => [String(s._id), s])
  );
  const connectorMap = Object.fromEntries(
    connectors.map((c) => [String(c._id), c])
  );

  // Where do you usually charge? Top stations by session count and energy
  const byStation = {};
  // What time do you usually charge? Hour-of-day histogram
  const byHour = new Array(24).fill(0);
  // What power do you usually use? Buckets by connector power
  const powerBuckets = {
    "<=7kW": 0,
    "7-22kW": 0,
    "22-50kW": 0,
    "50-150kW": 0,
    ">150kW": 0,
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
      if (power <= 7) powerBuckets["<=7kW"] += 1;
      else if (power <= 22) powerBuckets["7-22kW"] += 1;
      else if (power <= 50) powerBuckets["22-50kW"] += 1;
      else if (power <= 150) powerBuckets["50-150kW"] += 1;
      else powerBuckets[">150kW"] += 1;
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
