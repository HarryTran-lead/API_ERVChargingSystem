// src/controllers/membershipPlanAdminController.js
const MembershipPlan = require('../models/MembershipPlan');
const asyncHandler    = require('../utils/asyncHandler');
const { HttpError }   = require('../utils/errors');

// Clamp & chuẩn hoá modifiers
const sanitizeMods = (mods = {}) => {
  const num = (v, def = 0) => (v === undefined || v === null ? def : Number(v));
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  return {
    pricePerKwhPctOff:   clamp(num(mods.pricePerKwhPctOff),   0, 100),
    pricePerMinPctOff:   clamp(num(mods.pricePerMinPctOff),   0, 100),
    idleFeePerMinPctOff: clamp(num(mods.idleFeePerMinPctOff), 0, 100),
    graceMinBonus:       clamp(num(mods.graceMinBonus),       0, 60),
    minBalancePctOff:    clamp(num(mods.minBalancePctOff),    0, 100),
    queueBoost:          clamp(num(mods.queueBoost),          0, 10),
  };
};

/** POST /api/v1/admin/membership-plans */
exports.create = asyncHandler(async (req, res) => {
  const { code, name, monthly_fee_vnd = 0, status = 'ACTIVE', mods } = req.body || {};
  if (!code || !name) throw new HttpError(400, 'code and name are required');

  const doc = await MembershipPlan.create({
    code: String(code).toUpperCase().trim(),
    name: String(name).trim(),
    monthly_fee_vnd: Number(monthly_fee_vnd),
    status,
    mods: sanitizeMods(mods),
  });

  return res.status(201).json(doc);
});

/** GET /api/v1/admin/membership-plans?status=ACTIVE */
exports.list = asyncHandler(async (req, res) => {
  const q = {};
  if (req.query.status) q.status = String(req.query.status).toUpperCase();
  const docs = await MembershipPlan.find(q).sort({ monthly_fee_vnd: 1 }).lean();
  return res.json(docs);
});

/** GET /api/v1/admin/membership-plans/:id */
exports.getOne = asyncHandler(async (req, res) => {
  const doc = await MembershipPlan.findById(req.params.id).lean();
  if (!doc) throw new HttpError(404, 'Plan not found');
  return res.json(doc);
});

/** PATCH /api/v1/admin/membership-plans/:id */
exports.update = asyncHandler(async (req, res) => {
  const { name, monthly_fee_vnd, status, mods } = req.body || {};
  const upd = {};
  if (name !== undefined) upd.name = String(name).trim();
  if (monthly_fee_vnd !== undefined) upd.monthly_fee_vnd = Number(monthly_fee_vnd);
  if (status !== undefined) upd.status = String(status).toUpperCase();
  if (mods !== undefined) upd.mods = sanitizeMods(mods);

  // KHÔNG cho sửa code để tránh gãy dữ liệu quá khứ
  const doc = await MembershipPlan.findByIdAndUpdate(req.params.id, { $set: upd }, { new: true });
  if (!doc) throw new HttpError(404, 'Plan not found');
  return res.json(doc);
});

/** PATCH /api/v1/admin/membership-plans/:id/activate */
exports.activate = asyncHandler(async (req, res) => {
  const doc = await MembershipPlan.findByIdAndUpdate(req.params.id, { $set: { status: 'ACTIVE' } }, { new: true });
  if (!doc) throw new HttpError(404, 'Plan not found');
  return res.json(doc);
});

/** PATCH /api/v1/admin/membership-plans/:id/deactivate */
exports.deactivate = asyncHandler(async (req, res) => {
  const doc = await MembershipPlan.findByIdAndUpdate(req.params.id, { $set: { status: 'INACTIVE' } }, { new: true });
  if (!doc) throw new HttpError(404, 'Plan not found');
  return res.json(doc);
});

/** DELETE /api/v1/admin/membership-plans/:id */
exports.remove = asyncHandler(async (req, res) => {
  const done = await MembershipPlan.findByIdAndDelete(req.params.id);
  if (!done) throw new HttpError(404, 'Plan not found');
  return res.json({ ok: true });
});
