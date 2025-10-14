const Tariff = require("../models/Tariff");
const Station = require("../models/Station");
const asyncHandler = require("../utils/asyncHandler");
const { HttpError } = require("../utils/errors");

exports.createTariff = asyncHandler(async (req, res) => {
  const {
    stationId,
    mode,
    connectorType,
    pricePerKwh,
    pricePerMin,
    idleFeePerMin,
    graceMin,
    active = true,
    effectiveFrom,
  } = req.body;

  const st = await Station.findById(stationId).select("_id").lean();
  if (!st) throw new HttpError(400, "Invalid stationId");

  if (!effectiveFrom) throw new HttpError(400, "effectiveFrom is required");

  const t = await Tariff.create({
    stationId,
    mode,
    connectorType,
    pricePerKwh,
    pricePerMin,
    idleFeePerMin,
    graceMin,
    active,
    effectiveFrom: new Date(effectiveFrom),
  });
  res.status(201).json(t);
});

exports.listTariffs = asyncHandler(async (req, res) => {
  const { stationId, connectorType, active, page = 1, limit = 20 } = req.query;
  const q = {};
  if (stationId) q.stationId = stationId;
  if (connectorType) q.connectorType = connectorType;
  if (active !== undefined) q.active = String(active) === "true";

  const docs = await Tariff.find(q)
    .sort({ effectiveFrom: -1 })
    .skip((Number(page) - 1) * Number(limit))
    .limit(Number(limit))
    .lean();

  res.json(docs);
});

exports.getTariff = asyncHandler(async (req, res) => {
  const doc = await Tariff.findById(req.params.id).lean();
  if (!doc) throw new HttpError(404, "Tariff not found");
  res.json(doc);
});

exports.updateTariff = asyncHandler(async (req, res) => {
  // Lưu ý: Không sửa ngược lịch sử cho snapshot phiên đã chạy — tuỳ chính sách bạn có thể hạn chế trường này.
  const allowed = [
    "mode",
    "connectorType",
    "pricePerKwh",
    "pricePerMin",
    "idleFeePerMin",
    "graceMin",
    "active",
    "effectiveFrom",
  ];
  const upd = {};
  for (const k of allowed) if (k in req.body) upd[k] = req.body[k];

  const doc = await Tariff.findByIdAndUpdate(req.params.id, upd, { new: true });
  if (!doc) throw new HttpError(404, "Tariff not found");
  res.json(doc);
});

exports.deleteTariff = asyncHandler(async (req, res) => {
  const done = await Tariff.findByIdAndDelete(req.params.id);
  if (!done) throw new HttpError(404, "Tariff not found");
  res.json({ ok: true });
});

// Lấy bảng giá hiệu lực tại thời điểm (để snapshot khi start session)
exports.getEffectiveTariff = asyncHandler(async (req, res) => {
  const { stationId, connectorType, at } = req.query;
  if (!stationId) throw new HttpError(400, "stationId is required");
  if (!connectorType) throw new HttpError(400, "connectorType is required");
  const t = await Tariff.findEffectiveAt(stationId, connectorType, at);
  if (!t) return res.status(204).send(); // no content
  res.json(t);
});

// Tính min_required theo rule: max(200k, powerKw * 0.5 * pricePerKwh)
exports.getMinRequired = asyncHandler(async (req, res) => {
  const { powerKw, pricePerKwh } = req.query;
  const p = Number(powerKw);
  const price = Number(pricePerKwh);
  if (!Number.isFinite(p) || !Number.isFinite(price)) {
    throw new HttpError(400, "powerKw and pricePerKwh must be numbers");
  }
  const estimate = p * 0.5 * price;
  const minRequired = Math.max(200000, Math.ceil(estimate));
  res.json({ minRequired, estimate });
});
