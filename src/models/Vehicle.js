const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const { VEHICLE_PLUG_TYPES } = require("../constants/enums");

const VehicleSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true },
    userId: {
      type: String,
      ref: "User",
      required: true,
      index: true,
    },
    model: { type: String, required: true, trim: true },
    plugType: {
      type: String,
      enum: VEHICLE_PLUG_TYPES,
      required: true,
    },
    batteryKwh: {
      type: Number,
      required: true,
      min: [0.000001, "batteryKwh must be greater than 0"],
    },
  },
  { timestamps: true }
);

VehicleSchema.index({ userId: 1, id: 1 });

module.exports = mongoose.model("Vehicle", VehicleSchema);
