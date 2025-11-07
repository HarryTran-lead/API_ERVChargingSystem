const MembershipPlan = require('../models/MembershipPlan');
const UserMembership = require('../models/UserMembership');

const ZERO_MODS = {
  pricePerKwhPctOff: 0,
  pricePerMinPctOff: 0,
  idleFeePerMinPctOff: 0,
  graceMinBonus: 0,
  minBalancePctOff: 0,
};

const toPlain = (doc) =>
  doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;

const percentClamp = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, num));
};

const roundCurrency = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.round(num);
};

const buildPlanSnapshot = (planDoc) => {
  if (!planDoc) return null;
  const plain = toPlain(planDoc);
  const mods =
    typeof planDoc.getEffectiveMods === 'function'
      ? planDoc.getEffectiveMods()
      : ZERO_MODS;
  return {
    code: plain.code,
    name: plain.name,
    monthlyFeeVnd: plain.monthly_fee_vnd,
    mods: {
      pricePerKwhPctOff: percentClamp(mods.pricePerKwhPctOff),
      pricePerMinPctOff: percentClamp(mods.pricePerMinPctOff),
      idleFeePerMinPctOff: percentClamp(mods.idleFeePerMinPctOff),
      graceMinBonus: Number(mods.graceMinBonus) || 0,
      minBalancePctOff: percentClamp(mods.minBalancePctOff),
    },
  };
};

const buildMembershipSnapshot = (membershipDoc) => {
  if (!membershipDoc) return null;
  const plain = toPlain(membershipDoc);
  return {
    planCode: plain.plan_code,
    planName: plain.plan_name,
    status: plain.status,
    renewAt: plain.renew_at || null,
  };
};

async function resolveUserMembership(userId) {
  if (!userId) {
    return { membership: null, plan: null, mods: ZERO_MODS };
  }

  const membership = await UserMembership.findOne({
    user_id: userId,
    status: 'ACTIVE',
  });

  if (!membership) {
    return { membership: null, plan: null, mods: ZERO_MODS };
  }

  const plan = await MembershipPlan.findOne({
    code: membership.plan_code,
    status: 'ACTIVE',
  });

  const planSnapshot = buildPlanSnapshot(plan);
  return {
    membership: buildMembershipSnapshot(membership),
    plan: planSnapshot,
    mods: planSnapshot?.mods || ZERO_MODS,
  };
}

const applyPercentOff = (base, pct) => {
  if (!Number.isFinite(Number(base))) return 0;
  const normalizedPct = percentClamp(pct);
  const multiplier = Math.max(0, 1 - normalizedPct / 100);
  return roundCurrency(Number(base) * multiplier);
};

function applyMembershipPricing(basePricing = {}, mods = ZERO_MODS) {
  const baseRates = {
    pricePerMin: roundCurrency(basePricing.pricePerMin),
    pricePerKwh: roundCurrency(basePricing.pricePerKwh),
    idleFeePerMin: roundCurrency(basePricing.idleFeePerMin),
    graceMin: Number(basePricing.graceMin) || 0,
  };

  return {
    pricePerMin: applyPercentOff(baseRates.pricePerMin, mods.pricePerMinPctOff),
    pricePerKwh: applyPercentOff(baseRates.pricePerKwh, mods.pricePerKwhPctOff),
    idleFeePerMin: applyPercentOff(
      baseRates.idleFeePerMin,
      mods.idleFeePerMinPctOff
    ),
    graceMin: Math.max(0, Math.round(baseRates.graceMin + (mods.graceMinBonus || 0))),
    baseRates,
    applied: {
      pricePerMinPctOff: percentClamp(mods.pricePerMinPctOff),
      pricePerKwhPctOff: percentClamp(mods.pricePerKwhPctOff),
      idleFeePerMinPctOff: percentClamp(mods.idleFeePerMinPctOff),
      graceMinBonus: Number(mods.graceMinBonus) || 0,
      minBalancePctOff: percentClamp(mods.minBalancePctOff),
    },
  };
}

const computeMinBalanceRequirement = (baseAmount, mods = ZERO_MODS) => {
  const amount = roundCurrency(baseAmount);
  const pct = percentClamp(mods.minBalancePctOff);
  const discounted = amount * Math.max(0, 1 - pct / 100);
  return roundCurrency(discounted);
};

module.exports = {
  resolveUserMembership,
  applyMembershipPricing,
  computeMinBalanceRequirement,
  ZERO_MODS,
};