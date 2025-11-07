// src/models/Session.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { SESSION_STATUS_VALUES, PAYMENT_METHODS } = require('../constants/enums');

const SessionSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true },

    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      required: true,
      unique: true,
      index: true,
    },
    bookingRef: { type: String, index: true },

    userId: { type: String, ref: 'User', required: true, index: true },
    stationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Station',
      required: true,
      index: true,
    },
    connectorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Connector',
      required: true,
      index: true,
    },

    operatorId: { type: String, ref: 'User', index: true },
    stoppedBy: { type: String, ref: 'User' },

    paymentMethod: {
      type: String,
      enum: Object.values(PAYMENT_METHODS),
      default: PAYMENT_METHODS.WALLET,
    },

    status: {
      type: String,
      enum: SESSION_STATUS_VALUES,
      default: 'PENDING',
      index: true,
    },

    socStart: { type: Number, required: true },
    socEnd: { type: Number },
    socTarget: { type: Number, default: 100 },

    startedAt: { type: Date },
    expectedFullAt: { type: Date },
    idleFeeNoticeAt: { type: Date },
    stoppedAt: { type: Date },

    slotEnd: { type: Date, required: true },
    chargeDurationMinutes: { type: Number, required: true },
    idleFeeIntervalMinutes: { type: Number, required: true },

    totalChargingMinutes: { type: Number, default: 0 },
    totalIdleMinutes: { type: Number, default: 0 },
    idleFeeIntervalsApplied: { type: Number, default: 0 },

    minBalanceRequired: { type: Number, default: 0 },

    pricing: {
      tariffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tariff' },
      pricePerMin: { type: Number, default: 0 },
      idleFeePerMin: { type: Number, default: 0 },
      pricePerKwh: { type: Number, default: 0 },
      graceMin: { type: Number, default: 0 },
      currency: { type: String, default: 'VND' },
      effectiveFrom: { type: Date },
      mode: { type: String },
      connectorType: { type: String },

      // New: keep base rates + membership snapshot (for audit/visibility)
      baseRates: {
        pricePerMin: { type: Number, default: 0 },
        pricePerKwh: { type: Number, default: 0 },
        idleFeePerMin: { type: Number, default: 0 },
        graceMin: { type: Number, default: 0 },
      },
      membership: {
        planCode: { type: String },
        planName: { type: String },
        // included to match controller usage
        renewAt: { type: Date },
        applied: {
          pricePerMinPctOff: { type: Number, default: 0 },
          pricePerKwhPctOff: { type: Number, default: 0 },
          idleFeePerMinPctOff: { type: Number, default: 0 },
          graceMinBonus: { type: Number, default: 0 },
          minBalancePctOff: { type: Number, default: 0 },
        },
      },
    },

    billing: {
      chargingAmount: { type: Number, default: 0 },
      idleAmount: { type: Number, default: 0 },
      totalAmount: { type: Number, default: 0 },
      currency: { type: String, default: 'VND' },
      breakdown: {
        chargingRatePerMin: { type: Number, default: 0 },
        chargingRatePerKwh: { type: Number, default: 0 },
        chargingBillableMinutes: { type: Number, default: 0 },
        energyKwh: { type: Number, default: 0 },
        pricingMode: { type: String },
        idleRatePerMin: { type: Number, default: 0 },
        idleBillableMinutes: { type: Number, default: 0 },
      },
      membership: {
        planCode: { type: String },
        planName: { type: String },
        renewAt: { type: Date },
        applied: {
          pricePerMinPctOff: { type: Number, default: 0 },
          pricePerKwhPctOff: { type: Number, default: 0 },
          idleFeePerMinPctOff: { type: Number, default: 0 },
          graceMinBonus: { type: Number, default: 0 },
          minBalancePctOff: { type: Number, default: 0 },
        },
      },
    },

    chargingPredictions: {
      chargePercentageIn30Min: { type: Number, default: 0 },
      timeToFullChargeMinutes: { type: Number, default: null },
      energyChargedKwh: { type: Number, default: 0 },
      energyRemainingKwh: { type: Number, default: 0 },
    },

    // New: carry guest/walk-in info from proxy bookings
    walkInInfo: {
      name: { type: String, trim: true },
      phone: { type: String, trim: true },
      note: { type: String, trim: true },
    },
  },
  { timestamps: true }
);

SessionSchema.index({ connectorId: 1, status: 1 });

module.exports = mongoose.model('Session', SessionSchema);
