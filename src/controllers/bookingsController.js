// src/controllers/bookingController.js
const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Connector = require("../models/Connector");
const Vehicle = require("../models/Vehicle");
const asyncHandler = require("../utils/asyncHandler");
const { HttpError } = require("../utils/errors");
const { ensureRequestUserId } = require("../utils/requestUser");
const {
  BOOKING_SLOT_MINUTES,
  BOOKING_GRACE_MINUTES,
} = require("../constants/business");
const { BOOKING_STATUS } = require("../constants/enums");
const {
  scheduleNoShowJob,
  cancelNoShowJob,
} = require("../services/bookingScheduler");
const bookingMonitor = require("../services/bookingMonitor");
const { formatBookingDates } = require("../utils/timezoneHelpers");
const Station = require("../models/Station");
const Tariff = require("../models/Tariff");

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
    throw new HttpError(400, "connectorId and slotStart are required");
  }

  // Không cho client tự đính kèm snapshot xe — server sẽ tự lấy từ xe mặc định
  if (req.body.vehicle) {
    throw new HttpError(
      400,
      "Do not send vehicle details; the server uses your default vehicle."
    );
  }

  const userId = ensureRequestUserId(req);

  const start = new Date(slotStart);
  if (Number.isNaN(start.getTime())) {
    throw new HttpError(400, "Invalid slotStart value");
  }

  const normalizedStart = new Date(start);
  normalizedStart.setSeconds(0, 0);

  const now = new Date();
  if (
    normalizedStart.getTime() + BOOKING_SLOT_MINUTES * 60000 <=
    now.getTime()
  ) {
    throw new HttpError(400, "Slot must be in the future");
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
      "DEFAULT_VEHICLE_REQUIRED: You must register a vehicle and set a default vehicle before booking."
    );
  }

  // Nếu có gửi vehicleId thì vehicleId phải là xe mặc định
  if (vehicleId && vehicleId !== defaultVehicle.id) {
    throw new HttpError(
      400,
      "MUST_USE_DEFAULT_VEHICLE: You can only book with your default vehicle."
    );
  }

  // Kiểm tra user có booking đang active không (trừ slot liên tiếp)
  const userActiveBookings = await Booking.find({
    userId,
    status: { $in: [BOOKING_STATUS.RESERVED, BOOKING_STATUS.CHECKED_IN] },
  }).lean();

  if (userActiveBookings.length > 0) {
    // Kiểm tra xem có phải slot liên tiếp không
    const isConsecutiveSlot = userActiveBookings.some((booking) => {
      const bookingEnd = new Date(booking.slotEnd);
      const newStart = normalizedStart;

      // Cho phép slot liên tiếp (cách nhau tối đa 5 phút)
      const timeDiff = Math.abs(newStart.getTime() - bookingEnd.getTime());
      return timeDiff <= 5 * 60 * 1000; // 5 phút
    });

    if (!isConsecutiveSlot) {
      throw new HttpError(
        409,
        "You already have an active booking. Only consecutive slots are allowed."
      );
    }

    // Kiểm tra không quá 2 slot liên tiếp
    if (userActiveBookings.length >= 2) {
      throw new HttpError(
        409,
        "You can only book maximum 2 consecutive slots."
      );
    }
  }

  // Kiểm tra giới hạn 3 slot trong 1 ngày
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const todayBookings = await Booking.countDocuments({
    userId,
    slotStart: { $gte: today, $lt: tomorrow },
    status: { $ne: BOOKING_STATUS.CANCELLED },
  });

  if (todayBookings >= 3) {
    throw new HttpError(
      429,
      "Daily limit reached. You can only book 3 slots per day."
    );
  }

  const slotEnd = new Date(
    normalizedStart.getTime() + BOOKING_SLOT_MINUTES * 60 * 1000
  );
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
          Math.max(
            new Date(overlapping.slotStart).getTime(),
            normalizedStart.getTime()
          )
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
      { _id: connectorId, status: "IDLE" },
      { $set: { status: "RESERVED" } },
      { new: true }
    );

    if (!connectorDoc) {
      throw new HttpError(409, "Connector is not available for booking");
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
      await Connector.findByIdAndUpdate(connectorDoc._id, {
        $set: { status: "IDLE" },
      });
    }
    throw err;
  }

  scheduleNoShowJob(booking);
  bookingMonitor.syncBooking(booking);

  res.status(201).json({
    message: "Booking created successfully",
    booking: formatBookingDates(booking),
  });
});

exports.getMyBookings = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const bookings = await Booking.find({ userId })
    .sort({ slotStart: -1 })
    .lean();
  const formattedBookings = bookings.map((booking) =>
    formatBookingDates(booking)
  );
  res.json({ bookings: formattedBookings });
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
    throw new HttpError(404, "Booking not found");
  }
  if (booking.status !== BOOKING_STATUS.RESERVED) {
    throw new HttpError(409, "Only reserved bookings can be cancelled");
  }

  booking.status = BOOKING_STATUS.CANCELLED;
  await booking.save();
  bookingMonitor.syncBooking(booking);
  cancelNoShowJob(booking._id);

  await Connector.findOneAndUpdate(
    { _id: booking.connectorId, status: "RESERVED" },
    { $set: { status: "IDLE" } }
  );

  res.json({
    message: "Booking cancelled successfully",
    booking: formatBookingDates(booking),
  });
});

// GET /api/v1/bookings/available-slots
exports.getAvailableSlots = asyncHandler(async (req, res) => {
  const {
    stationId,
    date,
    connectorType,
    duration = BOOKING_SLOT_MINUTES,
  } = req.query;

  if (!stationId) {
    throw new HttpError(400, "stationId is required");
  }

  // Parse date (default to today if not provided)
  const targetDate = date ? new Date(date) : new Date();
  if (Number.isNaN(targetDate.getTime())) {
    throw new HttpError(400, "Invalid date format");
  }

  // Set time range for the day (00:00 to 23:59)
  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  // Get all connectors for the station
  const connectorFilter = {
    stationId,
    status: "IDLE",
  };

  if (connectorType) {
    connectorFilter.type = connectorType;
  }

  const connectors = await Connector.find(connectorFilter)
    .populate("stationId", "name lat lng status")
    .lean();

  if (connectors.length === 0) {
    return res.json({
      message: "No available connectors found",
      availableSlots: [],
      date: targetDate.toISOString().split("T")[0],
    });
  }

  // Get all existing bookings for the day
  const existingBookings = await Booking.find({
    stationId,
    status: { $in: [BOOKING_STATUS.RESERVED, BOOKING_STATUS.CHECKED_IN] },
    slotStart: { $gte: startOfDay, $lte: endOfDay },
  }).lean();

  // Generate time slots (every 30 minutes from 6 AM to 10 PM)
  const slots = [];
  const slotStartHour = 6; // 6 AM
  const slotEndHour = 22; // 10 PM

  for (let hour = slotStartHour; hour < slotEndHour; hour++) {
    for (let minute = 0; minute < 60; minute += 30) {
      const slotStart = new Date(targetDate);
      slotStart.setHours(hour, minute, 0, 0);

      const slotEnd = new Date(slotStart);
      slotEnd.setMinutes(slotEnd.getMinutes() + duration);

      // Skip if slot is in the past
      if (slotStart < new Date()) {
        continue;
      }

      // Check availability for each connector
      const availableConnectors = [];

      for (const connector of connectors) {
        // Check if this connector has any overlapping bookings
        const hasOverlap = existingBookings.some((booking) => {
          return (
            booking.connectorId.toString() === connector._id.toString() &&
            booking.slotStart < slotEnd &&
            new Date(booking.slotEnd) > slotStart
          );
        });

        if (!hasOverlap) {
          // Get tariff for this connector
          const tariff = await Tariff.findEffectiveAt(
            stationId,
            connector.type,
            slotStart
          );

          availableConnectors.push({
            connectorId: connector._id,
            connectorCode: connector.code,
            type: connector.type,
            powerKw: connector.powerKw,
            pricing: tariff
              ? {
                  pricePerMin: tariff.pricePerMin,
                  pricePerKwh: tariff.pricePerKwh,
                  idleFeePerMin: tariff.idleFeePerMin,
                  currency: "VND",
                  mode: tariff.mode,
                }
              : null,
          });
        }
      }

      if (availableConnectors.length > 0) {
        slots.push({
          slotStart: slotStart.toISOString(),
          slotEnd: slotEnd.toISOString(),
          duration: duration,
          availableConnectors: availableConnectors,
          station: {
            id: connectors[0].stationId._id,
            name: connectors[0].stationId.name,
            lat: connectors[0].stationId.lat,
            lng: connectors[0].stationId.lng,
            status: connectors[0].stationId.status,
          },
        });
      }
    }
  }

  res.json({
    message: "Available slots retrieved successfully",
    date: targetDate.toISOString().split("T")[0],
    totalSlots: slots.length,
    availableSlots: slots,
  });
});
