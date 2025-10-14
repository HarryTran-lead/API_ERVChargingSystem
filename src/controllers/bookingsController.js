// src/controllers/bookingController.js
const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const Connector = require('../models/Connector');
const Vehicle = require('../models/Vehicle');
const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../utils/errors');
const { ensureRequestUserId } = require('../utils/requestUser');
const {
  BOOKING_SLOT_MINUTES,
  BOOKING_GRACE_MINUTES,
} = require('../constants/business');
const { BOOKING_STATUS } = require('../constants/enums');
const { scheduleNoShowJob, cancelNoShowJob } = require('../services/bookingScheduler');
const bookingMonitor = require('../services/bookingMonitor');

const toMinutes = (ms) => ms / (60 * 1000);

const vehicleSnapshotFromDoc = (v) => {
  if (!v) return undefined;
  return {
    id: v.id, // UUID công khai
    make: v.make,
    model: v.model,
    plugType: v.plug_type, // map snake_case -> camelCase
    batteryKwh: v.battery_kwh,
    licensePlate: v.license_plate,
  };
};

exports.createBooking = asyncHandler(async (req, res) => {
  const { connectorId, slotStart, vehicleId } = req.body;
  if (!connectorId || !slotStart) {
    throw new HttpError(400, 'connectorId and slotStart are required');
  }

  // Không cho client tự đính kèm snapshot xe — server sẽ tự lấy từ xe mặc định
  if (req.body.vehicle) {
    throw new HttpError(
      400,
      'Do not send vehicle details; the server uses your default vehicle.'
    );
  }

  const userId = ensureRequestUserId(req);

  const start = new Date(slotStart);
  if (Number.isNaN(start.getTime())) {
    throw new HttpError(400, 'Invalid slotStart value');
  }

  const normalizedStart = new Date(start);
  normalizedStart.setSeconds(0, 0);

  const now = new Date();
  if (normalizedStart.getTime() + BOOKING_SLOT_MINUTES * 60000 <= now.getTime()) {
    throw new HttpError(400, 'Slot must be in the future');
  }

  // Bắt buộc phải có xe mặc định
  const defaultVehicle = await Vehicle.findOne({
    user_id: userId,
    is_default: true,
    deleted_at: null,
  }).lean();

  if (!defaultVehicle) {
    throw new HttpError(
      409,
      'DEFAULT_VEHICLE_REQUIRED: You must register a vehicle and set a default vehicle before booking.'
    );
  }

  // Nếu có gửi vehicleId thì vehicleId phải là xe mặc định
  if (vehicleId && vehicleId !== defaultVehicle.id) {
    throw new HttpError(
      400,
      'MUST_USE_DEFAULT_VEHICLE: You can only book with your default vehicle.'
    );
  }

  const slotEnd = new Date(normalizedStart.getTime() + BOOKING_SLOT_MINUTES * 60 * 1000);
  const checkInDeadline = new Date(
    normalizedStart.getTime() + BOOKING_GRACE_MINUTES * 60 * 1000
  );

  // Chống đặt chồng lấp trên cùng connector
  const overlapping = await Booking.findOne({
    connectorId,
    status: { $in: [BOOKING_STATUS.RESERVED, BOOKING_STATUS.CHECKED_IN] },
    slotStart: { $lt: slotEnd },
    slotEnd: { $gt: normalizedStart },
  }).lean();

  if (overlapping) {
    const overlapMinutes = Math.round(
      toMinutes(
        Math.min(new Date(overlapping.slotEnd).getTime(), slotEnd.getTime()) -
          Math.max(new Date(overlapping.slotStart).getTime(), normalizedStart.getTime())
      )
    );
    throw new HttpError(
      409,
      `Connector already reserved for the selected slot (overlap ${overlapMinutes} minutes)`
    );
  }

  const vehicleSnapshot = vehicleSnapshotFromDoc(defaultVehicle);

  let connectorDoc;
  let booking;
  try {
    // Reserve connector nếu đang IDLE
    connectorDoc = await Connector.findOneAndUpdate(
      { _id: connectorId, status: 'IDLE' },
      { $set: { status: 'RESERVED' } },
      { new: true }
    );

    if (!connectorDoc) {
      throw new HttpError(409, 'Connector is not available for booking');
    }

    booking = await Booking.create({
      userId,
      stationId: connectorDoc.stationId,
      connectorId,
      slotStart: normalizedStart,
      slotEnd,
      checkInDeadline,
      status: BOOKING_STATUS.RESERVED,
      vehicleId: defaultVehicle.id,
      vehicle: vehicleSnapshot,
    });
  } catch (err) {
    // rollback trạng thái connector
    if (connectorDoc) {
      await Connector.findByIdAndUpdate(connectorDoc._id, { $set: { status: 'IDLE' } });
    }
    throw err;
  }

  scheduleNoShowJob(booking);
  bookingMonitor.syncBooking(booking);

  res.status(201).json({
    message: 'Booking created successfully',
    booking: booking.toObject(),
  });
});

exports.getMyBookings = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const bookings = await Booking.find({ userId }).sort({ slotStart: -1 }).lean();
  res.json({ bookings });
});

exports.cancelBooking = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = ensureRequestUserId(req);

  const query = { userId, $or: [{ id }] };
  if (mongoose.Types.ObjectId.isValid(id)) {
    query.$or.push({ _id: id });
  }

  const booking = await Booking.findOne(query);
  if (!booking) {
    throw new HttpError(404, 'Booking not found');
  }
  if (booking.status !== BOOKING_STATUS.RESERVED) {
    throw new HttpError(409, 'Only reserved bookings can be cancelled');
  }

  booking.status = BOOKING_STATUS.CANCELLED;
  await booking.save();
  bookingMonitor.syncBooking(booking);
  cancelNoShowJob(booking._id);

  await Connector.findOneAndUpdate(
    { _id: booking.connectorId, status: 'RESERVED' },
    { $set: { status: 'IDLE' } }
  );

  res.json({
    message: 'Booking cancelled successfully',
    booking: booking.toObject(),
  });
});
