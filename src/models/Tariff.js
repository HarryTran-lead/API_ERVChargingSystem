const mongoose = require("mongoose");
const { TARIFF_MODE, TARIFF_CONNECTOR_TYPES } = require("../constants/enums");

const TariffSchema = new mongoose.Schema(
  {
    stationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Station",
      required: true,
      index: true,
    },
    mode: { type: String, enum: TARIFF_MODE, required: true },
    connectorType: {
      type: String,
      enum: TARIFF_CONNECTOR_TYPES,
      required: true,
    },
    pricePerKwh: { type: Number, required: true, min: 0, default: 0 }, // VND/kWh
    pricePerMin: { type: Number, required: true, min: 0, default: 0 }, // VND/min
    idleFeePerMin: { type: Number, required: true, min: 0, default: 0 }, // VND/min
    graceMin: { type: Number, required: true, min: 0, default: 5 },
    active: { type: Boolean, default: true, index: true },
    effectiveFrom: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);
TariffSchema.index(
  { stationId: 1, connectorType: 1, active: 1, effectiveFrom: -1 },
  { name: "station_connector_effective" }
);

// Tìm cái hiệu lực gần nhất tại thời điểm t: active=true & effectiveFrom<=t, sort desc
TariffSchema.statics.findEffectiveAt = async function (
  stationId,
  connectorType,
  at
) {
  const time = at ? new Date(at) : new Date();
  const filter = {
    stationId,
    active: true,
    effectiveFrom: { $lte: time },
  };

  if (connectorType) filter.connectorType = connectorType;

  return this.findOne(filter)

    .sort({ effectiveFrom: -1 })
    .lean();
};

module.exports = mongoose.model("Tariff", TariffSchema);
