const Charger = require("../models/Charger");
const Station = require("../models/Station");
const Connector = require("../models/Connector");
const asyncHandler = require("../utils/asyncHandler");
const { HttpError } = require("../utils/errors");

exports.createCharger = asyncHandler(async (req, res) => {
  const { stationId, name, code, status } = req.body;
  const station = await Station.findById(stationId).select("_id").lean();
  if (!station) {
    throw new HttpError(400, "Invalid stationId");
  }

  const charger = await Charger.create({
    stationId,
    name,
    code,
    status: status || "ONLINE",
  });

  res.status(201).json(charger);
});

exports.listChargers = asyncHandler(async (req, res) => {
  const { stationId, status, page = 1, limit = 20 } = req.query;
  const q = {};
  if (stationId) q.stationId = stationId;
  if (status) q.status = status;

  const chargers = await Charger.find(q)
    .skip((Number(page) - 1) * Number(limit))
    .limit(Number(limit))
    .lean();

  res.json(chargers);
});

exports.getCharger = asyncHandler(async (req, res) => {
  const charger = await Charger.findById(req.params.id).lean();
  if (!charger) {
    throw new HttpError(404, "Charger not found");
  }
  res.json(charger);
});

exports.updateCharger = asyncHandler(async (req, res) => {
  const { name, code, status } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (code !== undefined) updates.code = code;
  if (status !== undefined) updates.status = status;

  const charger = await Charger.findByIdAndUpdate(req.params.id, updates, {
    new: true,
  });

  if (!charger) {
    throw new HttpError(404, "Charger not found");
  }

  res.json(charger);
});

exports.deleteCharger = asyncHandler(async (req, res) => {
  const connectorCount = await Connector.countDocuments({
    chargerId: req.params.id,
  });

  if (connectorCount > 0) {
    throw new HttpError(409, "Cannot delete charger with existing connectors");
  }

  const deleted = await Charger.findByIdAndDelete(req.params.id);
  if (!deleted) {
    throw new HttpError(404, "Charger not found");
  }

  res.json({ ok: true });
});
