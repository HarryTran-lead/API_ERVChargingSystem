// src/controllers/membershipController.js
const MembershipPlan = require('../models/MembershipPlan');
const UserMembership  = require('../models/UserMembership');
const Wallet          = require('../models/Wallet');
const WalletTx        = require('../models/WalletTransaction');
const asyncHandler    = require('../utils/asyncHandler');
const { HttpError }   = require('../utils/errors');
const { ensureRequestUserId } = require('../utils/requestUser');

// GET /api/v1/memberships/mine
exports.getMine = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  let um = await UserMembership.findOne({ user_id: userId }).lean();
  if (!um) {
    const free = await MembershipPlan.findOne({ code: 'FREE', status: 'ACTIVE' }).lean();
    um = await UserMembership.create({
      user_id: userId,
      plan_code: free?.code || 'FREE',
      plan_name: free?.name || 'Free',
      monthly_fee_vnd: free?.monthly_fee_vnd || 0,
      status: 'ACTIVE'
    });
    return res.json({ membership: um, plan: free });
  }
  const plan = await MembershipPlan.findOne({ code: um.plan_code, status: 'ACTIVE' }).lean();
  return res.json({ membership: um, plan });
});

// POST /api/v1/memberships/switch  { planCode }
exports.switchPlan = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const planCode = String(req.body?.planCode || '').toUpperCase().trim();
  if (!planCode) throw new HttpError(400, 'planCode is required');

  const plan = await MembershipPlan.findOne({ code: planCode, status: 'ACTIVE' }).lean();
  if (!plan) throw new HttpError(404, 'Plan not found');

  const updated = await UserMembership.findOneAndUpdate(
    { user_id: userId },
    {
      $set: {
        plan_code: plan.code,
        plan_name: plan.name,
        monthly_fee_vnd: plan.monthly_fee_vnd,
        status: 'ACTIVE'
      }
    },
    { upsert: true, new: true }
  );

  return res.json({ membership: updated, plan });
});

// POST /api/v1/memberships/purchase  { planCode, months }
exports.purchase = asyncHandler(async (req, res) => {
  const userId   = ensureRequestUserId(req);
  const planCode = String(req.body?.planCode || '').toUpperCase().trim();
  const months   = Math.max(1, Math.min(12, Number(req.body?.months || 1)));

  const plan = await MembershipPlan.findOne({ code: planCode, status: 'ACTIVE' }).lean();
  if (!plan) throw new HttpError(404, 'Plan not found');

  const TIERS = { FREE: 0, BASIC: 1, PRO: 2 };   // định nghĩa thứ hạng gói
  const tierOf = (code) => TIERS[code] ?? -1;

  const cost = plan.monthly_fee_vnd * months;

  // Idempotency theo ngày (user/plan/months)
  const idem = `sub:purchase:${userId}:${planCode}:${months}:${new Date().toISOString().slice(0,10)}`;

  const session = await Wallet.startSession();
  await session.withTransaction(async () => {
    // lấy membership hiện tại (nếu có)
    const um = await UserMembership.findOne({ user_id: userId }).session(session);
    const currentCode = um?.plan_code || 'FREE';

    // RULE 1: nếu đang cùng gói => gia hạn
    // RULE 2: nếu mua gói cao hơn => UPGRADE ngay (cho phép)
    // RULE 3: nếu mua gói thấp hơn => chặn ở purchase (dùng switch riêng)
    if (um) {
      const curTier = tierOf(currentCode);
      const newTier = tierOf(plan.code);
      if (newTier < curTier) {
        throw new HttpError(409, 'DOWNGRADE_NOT_ALLOWED_IN_PURCHASE'); // nếu cần hạ gói -> dùng /switch
      }
    }

    // Thanh toán (bỏ qua nếu giá 0)
    if (cost > 0) {
      const w = await Wallet.findOne({ user_id: userId }).session(session);
      if (!w || w.balance < cost) throw new HttpError(402, 'INSUFFICIENT_FUNDS');

      const existed = await WalletTx.findOne({ user_id: userId, idempotency_key: idem }).session(session);
      if (!existed) {
        await WalletTx.create([{
          wallet_id: w.id,
          user_id: userId,
          type: 'DEBIT',             // lưu dương, chiều trừ theo type
          amount: cost,
          method: 'wallet',
          idempotency_key: idem,
          meta: { planCode: plan.code, months, action: um ? 'UPGRADE_OR_EXTEND' : 'NEW' }
        }], { session });

        await Wallet.updateOne(
          { user_id: userId },
          { $inc: { balance: -cost } },
          { session }
        );
      }
    }

    // Tính renew_at mới: base = MAX(now, renew_at hiện tại)
    const now = new Date();
    const baseDate = um?.renew_at && new Date(um.renew_at) > now ? new Date(um.renew_at) : now;
    const renew_at = new Date(baseDate);
    renew_at.setMonth(renew_at.getMonth() + months);

    // Cập nhật/khởi tạo membership (1 người 1 gói)
    await UserMembership.updateOne(
      { user_id: userId },
      {
        $set: {
          plan_code: plan.code,                 // nếu upgrade -> thay gói ngay
          plan_name: plan.name,
          monthly_fee_vnd: plan.monthly_fee_vnd,
          status: 'ACTIVE',
          renew_at
        }
      },
      { upsert: true, session }
    );
  });

  return res.status(201).json({ ok: true, plan: plan.code, months, cost });
});

// GET /api/v1/memberships/plans  -> driver xem tất cả gói đang bán
exports.listPlansForUser = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);

  const [plans, um] = await Promise.all([
    MembershipPlan
      .find({ status: 'ACTIVE' })
      .select('code name monthly_fee_vnd mods')   // chỉ field cần cho UI
      .sort({ monthly_fee_vnd: 1 })
      .lean(),
    UserMembership.findOne({ user_id: userId }).lean()
  ]);

  res.json({
    current: um?.plan_code || 'FREE',
    plans   : plans.map(p => ({
      code: p.code,
      name: p.name,
      monthly_fee_vnd: p.monthly_fee_vnd,
      mods: p.mods, // nếu muốn rút gọn có thể chỉ chọn vài key quan trọng
      isCurrent: um?.plan_code === p.code
    }))
  });
});

// (tuỳ chọn) GET /api/v1/memberships/plans/:code  -> xem chi tiết 1 gói
exports.getPlanPublic = asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').toUpperCase().trim();
  const plan = await MembershipPlan
    .findOne({ code, status: 'ACTIVE' })
    .select('code name monthly_fee_vnd mods')
    .lean();
  if (!plan) throw new HttpError(404, 'Plan not found');
  res.json(plan);
});
