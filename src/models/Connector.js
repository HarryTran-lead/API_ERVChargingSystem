// src/models/Connector.js
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const { CONNECTOR_STATUS } = require("../constants/enums");

const ConnectorSchema = new mongoose.Schema(
  {
    stationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Station",
      required: true,
      index: true,
    },
    chargerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Charger",
      required: true,
      index: true,
    },
    type: { type: String, required: true, trim: true }, // VD: DC, AC, CCS2
    powerKw: { type: Number, required: false, min: 0, default: 0 },
    status: {
      type: String,
      enum: CONNECTOR_STATUS,
      required: true,
      default: "IDLE",
    },
    code: { type: String, required: true, trim: true }, // unique trong station
    qrToken: { type: String, default: uuidv4, unique: true },
  },
  { timestamps: true }
);

ConnectorSchema.index({ chargerId: 1, code: 1 }, { unique: true });
ConnectorSchema.index({ chargerId: 1, status: 1 });
ConnectorSchema.index({ stationId: 1, status: 1 });
ConnectorSchema.index({ qrToken: 1 }, { unique: true });

module.exports = mongoose.model("Connector", ConnectorSchema);
