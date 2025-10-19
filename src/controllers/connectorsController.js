const Connector = require("../models/Connector");
const Station = require("../models/Station");
const Charger = require("../models/Charger");
const asyncHandler = require("../utils/asyncHandler");
const { HttpError } = require("../utils/errors");
const { MAX_CONNECTORS_PER_CHARGER } = require("../constants/business");

exports.createConnector = asyncHandler(async (req, res) => {
  const { chargerId, status, code } = req.body;
  const charger = await Charger.findById(chargerId)
    .select("_id stationId connectorType powerKw")
    .lean();
  if (!charger) {
    throw new HttpError(400, "Invalid chargerId");
  }

  if (!charger.connectorType) {
    throw new HttpError(409, "Charger is missing connector type configuration");
  }

  if (charger.powerKw === undefined || charger.powerKw === null) {
    throw new HttpError(409, "Charger is missing power configuration");
  }

  const st = await Station.findById(charger.stationId).select("_id").lean();
  if (!st) {
    throw new HttpError(409, "Charger is linked to an invalid station");
  }

  const connectorCount = await Connector.countDocuments({ chargerId });
  if (connectorCount >= MAX_CONNECTORS_PER_CHARGER) {
    throw new HttpError(
      409,
      `Charger already has ${MAX_CONNECTORS_PER_CHARGER} connectors`
    );
  }

  const c = await Connector.create({
    stationId: charger.stationId,
    chargerId,
    type: charger.connectorType,
    powerKw: charger.powerKw,
    status: status || "IDLE",
    code,
  });
  res.status(201).json(c);
});

exports.listConnectors = asyncHandler(async (req, res) => {
  const { stationId, chargerId, status, page = 1, limit = 20 } = req.query;
  const q = {};
  if (stationId) q.stationId = stationId;
  if (chargerId) q.chargerId = chargerId;
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
  const { code } = req.body;
  const connector = await Connector.findById(req.params.id);
  if (!connector) throw new HttpError(404, "Connector not found");

  if (code !== undefined) connector.code = code;

  const charger = await Charger.findById(connector.chargerId)
    .select("connectorType powerKw")
    .lean();
  if (!charger) {
    throw new HttpError(409, "Connector is linked to an invalid charger");
  }

  if (!charger.connectorType) {
    throw new HttpError(409, "Charger is missing connector type configuration");
  }

  if (charger.powerKw === undefined || charger.powerKw === null) {
    throw new HttpError(409, "Charger is missing power configuration");
  }

  connector.type = charger.connectorType;
  connector.powerKw = charger.powerKw;

  await connector.save();
  res.json(connector);
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

