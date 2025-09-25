const Connector = require("../models/Connector");
const Station = require("../models/Station");
const asyncHandler = require("../utils/asyncHandler");
const { HttpError } = require("../utils/errors");



exports.createConnector = asyncHandler(async (req, res) => {
  const { stationId, type, powerKw, status, code } = req.body;
  // validate station
  const st = await Station.findById(stationId).select("_id").lean();
  if (!st) throw new HttpError(400, "Invalid stationId");

  const c = await Connector.create({
    stationId,
    type,
    powerKw,
    status: status || "IDLE",
    code,
  });
  res.status(201).json(c);
});

exports.listConnectors = asyncHandler(async (req, res) => {
  const { stationId, status, page = 1, limit = 20 } = req.query;
  const q = {};
  if (stationId) q.stationId = stationId;
  if (status) q.status = status;

  const docs = await Connector.find(q)
    .skip((Number(page) - 1) * Number(limit))
    .limit(Number(limit))
    .lean();

  res.json(docs);
});

exports.getConnector = asyncHandler(async (req, res) => {
  const doc = await Connector.findById(req.params.id).lean();
  if (!doc) throw new HttpError(404, "Connector not found");
  res.json(doc);
});

exports.updateConnector = asyncHandler(async (req, res) => {
  const { type, powerKw, code } = req.body;
  const upd = {};
  if (type !== undefined) upd.type = type;
  if (powerKw !== undefined) upd.powerKw = powerKw;
  if (code !== undefined) upd.code = code;

  const doc = await Connector.findByIdAndUpdate(req.params.id, upd, {
    new: true,
  });
  if (!doc) throw new HttpError(404, "Connector not found");
  res.json(doc);
});

// PATCH status với rule: không cho OFFLINE khi đang CHARGING
exports.patchConnectorStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!status) throw new HttpError(400, "Missing status");

  const doc = await Connector.findById(req.params.id);
  if (!doc) throw new HttpError(404, "Connector not found");

  if (status === "OFFLINE" && doc.status === "CHARGING") {
    throw new HttpError(
      409,
      "Cannot set OFFLINE while CHARGING. Stop session first."
    );
  }

  doc.status = status;
  await doc.save();
  // TODO: broadcast socket.io update to console & app
  res.json(doc);
});

exports.deleteConnector = asyncHandler(async (req, res) => {
  const done = await Connector.findByIdAndDelete(req.params.id);
  if (!done) throw new HttpError(404, "Connector not found");
  res.json({ ok: true });
});
