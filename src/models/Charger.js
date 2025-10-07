const mongoose = require("mongoose");
const { CHARGER_STATUS } = require("../constants/enums");

const ChargerSchema = new mongoose.Schema(
  {
    stationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Station",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: CHARGER_STATUS,
      required: true,
      default: "ONLINE",
    },
  },
  { timestamps: true }
);

ChargerSchema.index({ stationId: 1, code: 1 }, { unique: true });

module.exports = mongoose.model("Charger", ChargerSchema);
