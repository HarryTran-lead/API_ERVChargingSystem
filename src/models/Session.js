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
