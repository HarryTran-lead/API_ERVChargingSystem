const mongoose = require("mongoose");
const { TARIFF_MODE } = require("../constants/enums");

const TariffSchema = new mongoose.Schema(
  {
    stationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Station",
      required: true,
      index: true,
    },
    mode: { type: String, enum: TARIFF_MODE, required: true },
    pricePerKwh: { type: Number, required: true, min: 0, default: 0 }, // VND/kWh
    pricePerMin: { type: Number, required: true, min: 0, default: 0 }, // VND/min
    idleFeePerMin: { type: Number, required: true, min: 0, default: 0 }, // VND/min
    graceMin: { type: Number, required: true, min: 0, default: 5 },
    active: { type: Boolean, default: true, index: true },
    effectiveFrom: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

// Tìm cái hiệu lực gần nhất tại thời điểm t: active=true & effectiveFrom<=t, sort desc
TariffSchema.statics.findEffectiveAt = async function (stationId, at) {
  const time = at ? new Date(at) : new Date();
  return this.findOne({
    stationId,
    active: true,
    effectiveFrom: { $lte: time },
  })
    .sort({ effectiveFrom: -1 })
    .lean();
};

module.exports = mongoose.model("Tariff", TariffSchema);
