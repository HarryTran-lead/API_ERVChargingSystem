const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')

const invoiceSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true },   // PK (uuid)
    user_id: { type: String, required: true, index: true },// chủ hóa đơn
    session_id: { type: String, required: true, unique: true }, // 1:1 với phiên sạc
    // Lưu VND ở đơn vị nhỏ nhất (số nguyên)
    total: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'VND' },
    pdf_url: { type: String, default: null },              // stub, sẽ render sau
    issued_at: { type: Date, default: Date.now },          // thời điểm xuất
    status: { type: String, enum: ['ISSUED', 'VOID'], default: 'ISSUED' },
    meta: { type: Object }
  },
  { timestamps: true, versionKey: false }
)

// Phục vụ truy vấn báo cáo
invoiceSchema.index({ user_id: 1, createdAt: -1 })

module.exports = mongoose.model('Invoice', invoiceSchema)
