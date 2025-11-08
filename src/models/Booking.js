// src/models/Booking.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const {
  BOOKING_STATUS_VALUES,
  VEHICLE_PLUG_TYPES,
  PAYMENT_METHODS,
} = require('../constants/enums');

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

    // Vehicle snapshot
    vehicleId: { type: String, ref: "Vehicle", index: true },
    vehicle: {
      id: { type: String, ref: "Vehicle" },
      make: { type: String, trim: true },
      model: { type: String, trim: true },
      plugType: { type: String, enum: VEHICLE_PLUG_TYPES },
      batteryKwh: { type: Number, min: 0 },
      licensePlate: { type: String, trim: true },
    },

    // New fields (merged)
    paymentMethod: {
      type: String,
      enum: Object.values(PAYMENT_METHODS),
      default: PAYMENT_METHODS.WALLET,
    },
    isPaid: { type: Boolean, default: false },
    createdByStaffId: { type: String, ref: "User", index: true },
    walkInInfo: {
      name: { type: String, trim: true },
      phone: { type: String, trim: true },
      note: { type: String, trim: true },
    },
  },
  { timestamps: true }
);

// Avoid overlapping reservations on the same connector
BookingSchema.index(
  { connectorId: 1, slotStart: 1, slotEnd: 1 },
  { name: 'booking_slot_overlap' }
);

module.exports = mongoose.model('Booking', BookingSchema);
