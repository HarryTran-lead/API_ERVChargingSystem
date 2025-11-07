const mongoose = require("mongoose");
const Session = require("../models/Session");
const Connector = require("../models/Connector");
const Booking = require("../models/Booking");
const { BOOKING_STATUS, SESSION_STATUS } = require("../constants/enums");
const bookingMonitor = require("./bookingMonitor");
const Invoice = require("../models/Invoice");
const { addMinutes } = require("../utils/constants");
const { calculateSocFromEnergy } = require("../utils/algorithms");

const toNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const computeSocAtStop = (
  session,
  elapsedMinutes,
  batteryKwh = null,
  connectorPowerKw = null
) => {
  const chargeDuration = toNumber(session.chargeDurationMinutes, 0);
  if (!chargeDuration) {
    return 100;
  }

  const socStart = toNumber(session.socStart, 0);
  const chargingMinutes = Math.min(elapsedMinutes, chargeDuration);

  // Use energy-based calculation if we have battery and connector data
  if (
    batteryKwh &&
    connectorPowerKw &&
    batteryKwh > 0 &&
    connectorPowerKw > 0
  ) {
    return calculateSocFromEnergy(
      socStart,
      batteryKwh,
      connectorPowerKw,
      chargingMinutes
    );
  }

  // Fallback to time-based calculation
  const progress = Math.min(1, chargingMinutes / chargeDuration);
  const socDelta = (100 - socStart) * progress;

  return Math.min(100, Number((socStart + socDelta).toFixed(1)));
};

const normalizeStopTime = (session, stoppedAtInput) => {
  if (
    stoppedAtInput instanceof Date &&
    !Number.isNaN(stoppedAtInput.getTime())
  ) {
    return stoppedAtInput;
  }

  const stoppedAtCandidate = new Date(stoppedAtInput);
  if (!Number.isNaN(stoppedAtCandidate.getTime())) {
    return stoppedAtCandidate;
  }

  if (
    session.startedAt instanceof Date &&
    !Number.isNaN(session.startedAt.getTime())
  ) {
    const durationMinutes = toNumber(session.chargeDurationMinutes, 0);
    if (durationMinutes > 0) {
      return new Date(
        session.startedAt.getTime() + Math.round(durationMinutes * 60 * 1000)
      );
    }
  }

  return new Date();
};

async function completeSession(session, options = {}) {
  if (!session) {
    return null;
  }

  const eligibleStatuses = [SESSION_STATUS.CHARGING, SESSION_STATUS.COMPLETED];

  if (!eligibleStatuses.includes(session.status)) {
    return session;
  }

  if (!session.startedAt) {
    throw new Error("Session start timestamp is missing");
  }

  const stoppedAt = normalizeStopTime(session, options.stoppedAt);
  const elapsedMinutes = Math.max(
    0,
    (stoppedAt.getTime() - session.startedAt.getTime()) / 60000
  );

  // Get connector power for accurate SOC calculation
  let connectorPowerKw = 0;
  if (session.connectorId) {
    const connector = await Connector.findById(session.connectorId)
      .select("powerKw")
      .lean();
    connectorPowerKw = toNumber(connector?.powerKw, 0);
  }

  // Get battery info from booking if available
  let batteryKwh = null;
  if (session.bookingId) {
    const booking = await Booking.findById(session.bookingId)
      .select("vehicle.batteryKwh vehicleId")
      .lean();

    if (booking?.vehicle?.batteryKwh) {
      batteryKwh = toNumber(booking.vehicle.batteryKwh, 0);
    }
  }

  const socEnd = computeSocAtStop(
    session,
    elapsedMinutes,
    batteryKwh,
    connectorPowerKw
  );
  const chargeDuration = toNumber(session.chargeDurationMinutes, 0);
  const totalChargingMinutes = Math.min(elapsedMinutes, chargeDuration);
  const totalIdleMinutes = Math.max(0, elapsedMinutes - chargeDuration);
  const idleIntervalRaw = toNumber(session.idleFeeIntervalMinutes, 0);
  const idleFeeIntervalsApplied =
    idleIntervalRaw > 0 && totalIdleMinutes > 0
      ? Math.ceil(totalIdleMinutes / idleIntervalRaw)
      : 0;

  session.status = SESSION_STATUS.COMPLETED;
  session.socEnd = socEnd;
  session.stoppedAt = stoppedAt;
  session.totalChargingMinutes = Number(totalChargingMinutes.toFixed(1));
  session.totalIdleMinutes = Number(totalIdleMinutes.toFixed(1));
  session.idleFeeIntervalsApplied = idleFeeIntervalsApplied;

  const normalizedChargingMinutes = toNumber(session.totalChargingMinutes, 0);
  const normalizedIdleMinutes = toNumber(session.totalIdleMinutes, 0);
  const pricePerMin = toNumber(session.pricing?.pricePerMin, 0);
  const pricePerKwh = toNumber(session.pricing?.pricePerKwh, 0);
  const idleRatePerMin = toNumber(session.pricing?.idleFeePerMin, 0);
  const graceMin = toNumber(session.pricing?.graceMin, 0);
  const pricingModeRaw = session.pricing?.mode;
  const pricingMode =
    typeof pricingModeRaw === "string"
      ? pricingModeRaw.toLowerCase()
      : undefined;
  // Bỏ graceMin - tính phí idle ngay khi sạc completed
  const billableIdleMinutes = Number(normalizedIdleMinutes.toFixed(1));

  let energyKwh = null;
  if (connectorPowerKw > 0 && normalizedChargingMinutes > 0) {
    const energy = (connectorPowerKw * normalizedChargingMinutes) / 60;
    energyKwh = Number(energy.toFixed(3));
  }

  const amountFromTime = Math.round(pricePerMin * normalizedChargingMinutes);
  const amountFromEnergy =
    pricePerKwh > 0 && energyKwh !== null
      ? Math.round(pricePerKwh * energyKwh)
      : 0;

  let chargingAmount = amountFromTime;
  if (pricingMode === "energy") {
    chargingAmount = amountFromEnergy || amountFromTime;
  } else if (pricingMode === "hybrid") {
    chargingAmount = amountFromTime + amountFromEnergy;
  } else if (pricingMode !== "time") {
    chargingAmount = amountFromTime || amountFromEnergy;
  }

  const idleAmount = Math.round(idleRatePerMin * billableIdleMinutes);
  const currency =
    session.pricing?.currency || session.billing?.currency || "VND";

  const breakdown = {
    chargingRatePerMin: pricePerMin,
    chargingRatePerKwh: pricePerKwh,
    chargingBillableMinutes: normalizedChargingMinutes,
    idleRatePerMin: idleRatePerMin,
    idleBillableMinutes: billableIdleMinutes,
    pricingMode: pricingModeRaw || null,
  };

  if (energyKwh !== null) {
    breakdown.energyKwh = energyKwh;
  }

  session.billing = {
    chargingAmount,
    idleAmount,
    totalAmount: chargingAmount + idleAmount,
    currency,
    breakdown,
  };
  if (session.pricing?.membership) {
    session.billing.membership = {
      planCode: session.pricing.membership.planCode || null,
      planName: session.pricing.membership.planName || null,
      renewAt: session.pricing.membership.renewAt || null,
      applied: session.pricing.membership.applied || {
        pricePerMinPctOff: 0,
        pricePerKwhPctOff: 0,
        idleFeePerMinPctOff: 0,
        graceMinBonus: 0,
        minBalancePctOff: 0,
      },
    };
  }
  await session.save();

  if (session.connectorId) {
    await Connector.findByIdAndUpdate(session.connectorId, { status: "IDLE" });
  }

  if (session.bookingId) {
    const updatedBooking = await Booking.findByIdAndUpdate(
      session.bookingId,
      { status: BOOKING_STATUS.COMPLETED },
      { new: true }
    );

    if (updatedBooking) {
      bookingMonitor.syncBooking(updatedBooking);
    }
  }

  // Auto-create invoice with due date (e.g. 24h)
  const total = session.billing?.totalAmount || 0;
  if (total > 0 && session?.id && session?.userId) {
    const dueHours = Number(process.env.INVOICE_DUE_HOURS || 24);
    const due_at = new Date(
      Date.now() + Math.max(1, dueHours) * 60 * 60 * 1000
    );
    await Invoice.findOneAndUpdate(
      { session_id: session.id },
      {
        user_id: session.userId,
        session_id: session.id,
        total,
        currency,
        issued_at: new Date(),
        due_at,
        payment_status: "UNPAID",
        status: "ISSUED",
        meta: {
          stationId: session.stationId,
          connectorId: session.connectorId,
          membership: session.pricing?.membership || null,
          billing: {
            chargingAmount,
            idleAmount,
            totalAmount: total,
            currency,
          },
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  return session;
}

const buildSessionLookup = (reference) => {
  if (!reference) {
    return null;
  }

  const query = { $or: [] };

  if (mongoose.Types.ObjectId.isValid(reference)) {
    query.$or.push({ _id: reference });
  }

  if (typeof reference === "string") {
    query.$or.push({ id: reference });
  }

  if (query.$or.length === 0) {
    return null;
  }

  return query;
};

async function completeSessionByReference(reference, options = {}) {
  const query = buildSessionLookup(reference);
  if (!query) {
    return null;
  }

  const session = await Session.findOne(query);
  if (!session) {
    return null;
  }

  const eligibleStatuses = [SESSION_STATUS.CHARGING, SESSION_STATUS.COMPLETED];

  if (!eligibleStatuses.includes(session.status)) {
    return session;
  }

  return completeSession(session, options);
}

module.exports = {
  completeSession,
  completeSessionByReference,
};
