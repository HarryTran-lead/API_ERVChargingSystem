// src/controllers/membershipController.js
const MembershipPlan = require('../models/MembershipPlan');
const UserMembership = require('../models/UserMembership');
const Wallet = require('../models/Wallet');
const WalletTx = require('../models/WalletTransaction');
const { safeNotifyUser } = require('../services/notificationService');
const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../utils/errors');
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
      status: 'ACTIVE',
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

  const previous = await UserMembership.findOne({ user_id: userId }).lean();

  const updated = await UserMembership.findOneAndUpdate(
    { user_id: userId },
    {
      $set: {
        plan_code: plan.code,
        plan_name: plan.name,
        monthly_fee_vnd: plan.monthly_fee_vnd,
        status: 'ACTIVE',
      },
    },
    { upsert: true, new: true }
  );

  const messageParts = [`You have switched to the ${plan.name} plan.`];
  if (previous?.plan_name && previous.plan_code !== plan.code) {
    messageParts.push(`Previously: ${previous.plan_name} (${previous.plan_code}).`);
  }
  const previousRenewIso = previous?.renew_at ? new Date(previous.renew_at).toISOString() : null;
  if (previousRenewIso) {
    messageParts.push(`Previous renewal date: ${previousRenewIso}.`);
  }

  await safeNotifyUser({
    userId,
    title: 'Membership plan updated',
    body: messageParts.join(' '),
    type: 'membership.switch',
    data: {
      planCode: plan.code,
      planName: plan.name,
      monthlyFeeVnd: plan.monthly_fee_vnd,
      previousPlan: previous?.plan_code || null,
      previousPlanName: previous?.plan_name || null,
      previousRenewAt: previousRenewIso,
    },
  });

  return res.json({ membership: updated, plan });
});

// POST /api/v1/memberships/purchase  { planCode, months }
exports.purchase = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const planCode = String(req.body?.planCode || '').toUpperCase().trim();
  const months = Math.max(1, Math.min(12, Number(req.body?.months || 1)));

  const plan = await MembershipPlan.findOne({ code: planCode, status: 'ACTIVE' }).lean();
  if (!plan) throw new HttpError(404, 'Plan not found');

  const TIERS = { FREE: 0, BASIC: 1, PRO: 2 }; // định nghĩa thứ hạng gói
  const tierOf = (code) => TIERS[code] ?? -1;

  const cost = plan.monthly_fee_vnd * months;

  // Idempotency theo ngày (user/plan/months)
  const idem = `sub:purchase:${userId}:${planCode}:${months}:${new Date().toISOString().slice(0, 10)}`;

  const session = await Wallet.startSession();

  const membershipChange = {
    previousPlan: null,
    previousRenewAt: null,
    renewAt: null,
    action: 'NEW',
  };

  try {
    await session.withTransaction(async () => {
      // lấy membership hiện tại (nếu có)
      const um = await UserMembership.findOne({ user_id: userId }).session(session);
      const currentCode = um?.plan_code || 'FREE';
      membershipChange.previousPlan = um
        ? { code: um.plan_code, name: um.plan_name || um.plan_code }
        : null;
      membershipChange.previousRenewAt = um?.renew_at || null;

      // RULE 1: nếu đang cùng gói => gia hạn
      // RULE 2: nếu mua gói cao hơn => UPGRADE ngay (cho phép)
      // RULE 3: nếu mua gói thấp hơn => chặn ở purchase (dùng switch riêng)
      if (um) {
        const curTier = tierOf(currentCode);
        const newTier = tierOf(plan.code);
        if (newTier < curTier) {
          throw new HttpError(409, 'DOWNGRADE_NOT_ALLOWED_IN_PURCHASE'); // nếu cần hạ gói -> dùng /switch
        }
        membershipChange.action = newTier > curTier ? 'UPGRADE' : 'EXTEND';
      } else {
        membershipChange.action = 'NEW';
      }

      // Thanh toán (bỏ qua nếu giá 0)
      if (cost > 0) {
        const w = await Wallet.findOne({ user_id: userId }).session(session);
        if (!w || w.balance < cost) throw new HttpError(402, 'INSUFFICIENT_FUNDS');

        const existed = await WalletTx.findOne({
          user_id: userId,
          idempotency_key: idem,
        }).session(session);

        if (!existed) {
          await WalletTx.create(
            [
              {
                wallet_id: w.id,
                user_id: userId,
                type: 'DEBIT', // lưu dương, chiều trừ theo type
                amount: cost,
                method: 'wallet',
                idempotency_key: idem,
                meta: { planCode: plan.code, months, action: membershipChange.action },
              },
            ],
            { session }
          );

          await Wallet.updateOne({ user_id: userId }, { $inc: { balance: -cost } }, { session });
        }
      }

      // Tính renew_at mới: base = MAX(now, renew_at hiện tại)
      const now = new Date();
      const baseDate = um?.renew_at && new Date(um.renew_at) > now ? new Date(um.renew_at) : now;
      const renew_at = new Date(baseDate);
      renew_at.setMonth(renew_at.getMonth() + months);
      membershipChange.renewAt = renew_at;

      // Cập nhật/khởi tạo membership (1 người 1 gói)
      await UserMembership.updateOne(
        { user_id: userId },
        {
          $set: {
            plan_code: plan.code, // nếu upgrade -> thay gói ngay
            plan_name: plan.name,
            monthly_fee_vnd: plan.monthly_fee_vnd,
            status: 'ACTIVE',
            renew_at,
          },
        },
        { upsert: true, session }
      );
    });
  } finally {
    await session.endSession();
  }

  const renewAtIso = membershipChange.renewAt ? membershipChange.renewAt.toISOString() : null;

  const details = [];
  if (cost > 0) {
    details.push(`Total charge: ${cost.toLocaleString('en-US')} VND.`);
  }
  if (renewAtIso) {
    details.push(`Next renewal: ${renewAtIso}.`);
  }
  const previousRenewIso = membershipChange.previousRenewAt
    ? new Date(membershipChange.previousRenewAt).toISOString()
    : null;
  if (membershipChange.previousPlan?.code && membershipChange.previousPlan.code !== plan.code) {
    details.push(`Previous plan: ${membershipChange.previousPlan.name} (${membershipChange.previousPlan.code}).`);
  }
  if (previousRenewIso) {
    details.push(`Previous renewal date: ${previousRenewIso}.`);
  }

  const actionVerb =
    membershipChange.action === 'UPGRADE'
      ? 'upgraded to'
      : membershipChange.action === 'EXTEND'
      ? 'extended'
      : 'activated';

  await safeNotifyUser({
    userId,
    title: 'Membership purchase successful',
    body: [
      `You have ${actionVerb} the ${plan.name} plan for ${months} month${months > 1 ? 's' : ''}.`,
      ...details,
    ].join(' '),
    type: 'membership.purchase',
    data: {
      planCode: plan.code,
      planName: plan.name,
      months,
      cost,
      renewAt: renewAtIso,
      previousPlan: membershipChange.previousPlan?.code || null,
      previousPlanName: membershipChange.previousPlan?.name || null,
      previousRenewAt: previousRenewIso,
      action: membershipChange.action,
    },
  });

  return res.status(201).json({ ok: true, plan: plan.code, months, cost });
});

// GET /api/v1/memberships/plans  -> driver xem tất cả gói đang bán
exports.listPlansForUser = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);

  const [plans, um] = await Promise.all([
    MembershipPlan.find({ status: 'ACTIVE' })
      .select('code name monthly_fee_vnd mods')
      .sort({ monthly_fee_vnd: 1 })
      .lean(),
    UserMembership.findOne({ user_id: userId }).lean(),
  ]);

  res.json({
    current: um?.plan_code || 'FREE',
    plans: plans.map((p) => ({
      code: p.code,
      name: p.name,
      monthly_fee_vnd: p.monthly_fee_vnd,
      mods: p.mods,
      isCurrent: um?.plan_code === p.code,
    })),
  });
});
