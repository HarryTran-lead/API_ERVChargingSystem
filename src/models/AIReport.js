// models/AIReport.js
const mongoose = require("mongoose");

const AIReportSchema = new mongoose.Schema(
  {
    generatedAt: { type: Date, default: Date.now, index: true },
    period: { type: String, required: true }, // last_6_months, last_year...
    summary: {
      totalSessions: Number,
      totalKwh: Number,
      stationsAnalyzed: Number,
    },
    aiInsight: {
      analysis: String,
      forecast: {
        next_3_months: {
          estimated_sessions: Number,
          estimated_kwh: Number,
          peak_hours: [Number],
        },
      },
      recommendations: [String],
    },
    rawDataSample: [mongoose.Schema.Types.Mixed], // lưu mẫu dữ liệu
  },
  { timestamps: true }
);

// Index để query nhanh
AIReportSchema.index({ generatedAt: -1 });

module.exports = mongoose.model("AIReport", AIReportSchema);
