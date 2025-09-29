const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const { BOOKING_STATUS_VALUES } = require("../constants/enums");

const BookingSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true },
    userId: { type: String, ref: "User", required: true, index: true },
    stationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Station",
      required: true,
      index: true,
    },
    connectorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Connector",
      required: true,
      index: true,
    },
    slotStart: { type: Date, required: true },
    slotEnd: { type: Date, required: true },
    checkInDeadline: { type: Date, required: true },
    status: {
      type: String,
      enum: BOOKING_STATUS_VALUES,
      default: "RESERVED",
      index: true,
    },
  },
  { timestamps: true }
);

BookingSchema.index(
  { connectorId: 1, slotStart: 1, slotEnd: 1 },
  { name: "booking_slot_overlap" }
);

module.exports = mongoose.model("Booking", BookingSchema);
