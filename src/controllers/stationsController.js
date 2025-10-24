const Station = require("../models/Station");
const asyncHandler = require("../utils/asyncHandler");
const { HttpError } = require("../utils/errors");
const Charger = require("../models/Charger");
const Connector = require("../models/Connector");
const mongoose = require("mongoose");

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);
exports.createStation = asyncHandler(async (req, res) => {
  const { name, lat, lng, status } = req.body;
  if (typeof lat !== "number" || typeof lng !== "number") {
    throw new HttpError(400, "lat/lng must be numbers");
  }
  const station = await Station.create({
    name,
    lat,
    lng,
    status: status || "ONLINE",
    location: { type: "Point", coordinates: [lng, lat] },
  });
  res.status(201).json(station);
});

exports.listStations = asyncHandler(async (req, res) => {
  const { status, near, radiusKm = 5, page = 1, limit = 20 } = req.query;
  const q = {};
  if (status) q.status = status;

  let query = Station.find(q);
  if (near) {
    // near = "lat,lng"
    const [lat, lng] = near.split(",").map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      query = Station.find({
        location: {
          $near: {
            $geometry: { type: "Point", coordinates: [lng, lat] },
            $maxDistance: Number(radiusKm) * 1000,
          },
        },
      });
    }
  }

  const docs = await query
    .skip((Number(page) - 1) * Number(limit))
    .limit(Number(limit))
    .lean();

  res.json(docs);
});

exports.getStation = asyncHandler(async (req, res) => {
  const st = await Station.findById(req.params.id).lean();
  if (!st) throw new HttpError(404, "Station not found");
  res.json(st);
});

exports.updateStation = asyncHandler(async (req, res) => {
  const { name, lat, lng, status } = req.body;
  const upd = {};
  if (name !== undefined) upd.name = name;
  if (lat !== undefined) upd.lat = lat;
  if (lng !== undefined) upd.lng = lng;
  if (status !== undefined) upd.status = status;
  if (lat !== undefined && lng !== undefined) {
    upd.location = { type: "Point", coordinates: [lng, lat] };
  }
  const st = await Station.findByIdAndUpdate(req.params.id, upd, { new: true });
  if (!st) throw new HttpError(404, "Station not found");
  res.json(st);
});

exports.listStationsWithAssets = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const filter = {};

  if (status) {
    filter.status = status;
  }

  const stations = await Station.find(filter).lean();

  if (stations.length === 0) {
    res.json([]);
    return;
  }

  const stationIds = stations.map((st) => st._id);

  const chargers = await Charger.find({
    stationId: { $in: stationIds },
  }).lean();

  const chargerIds = chargers.map((charger) => charger._id);

  const connectors = chargerIds.length
    ? await Connector.find({ chargerId: { $in: chargerIds } }).lean()
    : [];

  const connectorsByCharger = connectors.reduce((acc, connector) => {
    const chargerId = connector.chargerId?.toString();
    if (!chargerId) return acc;
    if (!acc[chargerId]) acc[chargerId] = [];
    acc[chargerId].push(connector);
    return acc;
  }, {});

  const chargersByStation = chargers.reduce((acc, charger) => {
    const stationId = charger.stationId?.toString();
    if (!stationId) return acc;
    if (!acc[stationId]) acc[stationId] = [];
    acc[stationId].push({
      ...charger,
      connectors: connectorsByCharger[charger._id.toString()] || [],
    });
    return acc;
  }, {});

  const result = stations.map((station) => ({
    ...station,
    chargers: chargersByStation[station._id.toString()] || [],
  }));

  res.json(result);
});




exports.deleteStation = asyncHandler(async (req, res) => {
  const done = await Station.findByIdAndDelete(req.params.id);
  if (!done) throw new HttpError(404, "Station not found");
  res.json({ ok: true });
});
