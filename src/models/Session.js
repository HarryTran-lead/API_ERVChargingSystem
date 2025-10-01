const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const { SESSION_STATUS_VALUES } = require("../constants/enums");

const SessionSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      unique: true,
      index: true,
    },
    bookingRef: { type: String, index: true },
    userId: { type: String, ref: "User", required: true, index: true },
    stationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Station",
      required: true,
      index: true,
    },
    connectorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Connector",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: SESSION_STATUS_VALUES,
      default: "PENDING",
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
  },
  { timestamps: true }
);

SessionSchema.index({ connectorId: 1, status: 1 });

module.exports = mongoose.model("Session", SessionSchema);
