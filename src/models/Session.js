
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
=======
const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')

const { Schema } = mongoose

const sessionSchema = new Schema(
  {
    id: { type: String, default: uuidv4, unique: true },          // PK (uuid)
    // Quan hệ (string UUID từ các model khác)
    booking_id: { type: String, default: null },                   // 0..1 session/booking
    user_id: { type: String, required: true, index: true },        // chủ phiên (driver)
    vehicle_id: { type: String, default: null },                   // optional
    connector_id: { type: String, required: true, index: true },
    tariff_id: { type: String, required: true },                   // bản giá gốc tại thời điểm start

    // Snapshot pricing để tính tiền ổn định (immutable trong phiên)
    pricing_json: {
      type: Schema.Types.Mixed,                                    // { mode, price_per_kwh, price_per_min, idle_fee_per_min, grace_min }
      default: {}
    },

    // Số liệu đo đạc
    soc_start: { type: Number, min: 0, max: 100, default: null },
    soc_end: { type: Number, min: 0, max: 100, default: null },
    kwh: { type: Number, min: 0, default: 0 },                     // năng lượng nạp
    duration_min: { type: Number, min: 0, default: 0 },            // tổng phút (charging)

    // Tính tiền
    cost: { type: Number, min: 0, default: 0 },                    // VND (số nguyên)

    // Trạng thái phiên
    status: {
      type: String,
      enum: ['DRAFT','CHARGING','FINISHED','PAYMENT_PENDING','CLOSED','ABORTED'],
      default: 'DRAFT',
      index: true
    },

    // Mốc thời gian thực tế
    started_at: { type: Date, default: null },
    finished_at: { type: Date, default: null }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

// Đảm bảo 0..1 session/booking (unique khi có booking_id)
sessionSchema.index(
  { booking_id: 1 },
  { unique: true, partialFilterExpression: { booking_id: { $type: 'string' } } }
)

// Truy vấn gần đây nhanh
sessionSchema.index({ user_id: 1, createdAt: -1 })
sessionSchema.index({ connector_id: 1, createdAt: -1 })

module.exports = mongoose.model('Session', sessionSchema)

