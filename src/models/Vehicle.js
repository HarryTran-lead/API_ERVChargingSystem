// src/models/Vehicle.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const vehicleSchema = new mongoose.Schema(
  {
    // Public ID (UUID giống User.id)
    id: { type: String, default: uuidv4, unique: true },

    // Tham chiếu theo UUID "users.id" (không phải _id của Mongo)
    user_id: { type: String, required: true, index: true },

    // Biển số
    license_plate: { type: String, required: true, minlength: 3, maxlength: 32 },
    // Biển số chuẩn hoá để unique theo user (UPPER + bỏ space/dấu gạch)
    license_plate_norm: { type: String, required: true },

    // Thông tin xe
    make: { type: String, required: true, minlength: 1, maxlength: 100 },   // Hãng
    model: { type: String, required: true, minlength: 1, maxlength: 100 },  // Dòng
    year: { type: Number, min: 1980, max: 2100 },                           // Tuỳ chọn
    color: { type: String, minlength: 1, maxlength: 50 },

    // Đầu nối & pin
    plug_type: {
      type: String,
      enum: ['CCS2', 'CHAdeMO', 'AC_Type2', 'GB/T', 'Other'],
      required: true
    },
    battery_kwh: { type: Number, min: 1, max: 500, required: true },

    // Mặc định & soft-delete
    is_default: { type: Boolean, default: false },
    deleted_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

/* =========================
   Hooks
========================= */

// Chuẩn hoá biển số trước validate
vehicleSchema.pre('validate', function (next) {
  const raw = this.license_plate || '';
  this.license_plate_norm = raw.toUpperCase().replace(/[\s-]/g, '');
  next();
});

// Đảm bảo mỗi user chỉ có 1 xe default (unset default cũ nếu cần)
vehicleSchema.pre('save', async function () {
  if (this.is_default) {
    await this.constructor.updateMany(
      { user_id: this.user_id, _id: { $ne: this._id }, deleted_at: null, is_default: true },
      { $set: { is_default: false } }
    );
  }
});

/* =========================
   Indexes
========================= */

// Unique biển số theo user (bỏ qua bản đã xoá mềm)
vehicleSchema.index(
  { user_id: 1, license_plate_norm: 1 },
  { unique: true, partialFilterExpression: { deleted_at: null } }
);

// Đảm bảo chỉ 1 default / user (bỏ qua bản đã xoá mềm)
vehicleSchema.index(
  { user_id: 1 },
  { unique: true, partialFilterExpression: { is_default: true, deleted_at: null } }
);

module.exports = mongoose.model('Vehicle', vehicleSchema);

