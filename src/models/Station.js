const mongoose = require("mongoose");
const { STATION_STATUS } = require("../constants/enums");

const StationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    status: {
      type: String,
      enum: STATION_STATUS,
      required: true,
      default: "ONLINE",
    },
    // optional: for Geo search with 2dsphere
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], default: undefined }, // [lng, lat]
    },
  },
  { timestamps: true }
);

StationSchema.index({ status: 1 });
StationSchema.index({ location: "2dsphere" }); // optional

module.exports = mongoose.model("Station", StationSchema);
