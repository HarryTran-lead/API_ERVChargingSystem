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
const { BOOKING_STATUS, VEHICLE_PLUG_TYPES } = require("../constants/enums");
const {
  scheduleNoShowJob,
  cancelNoShowJob,
} = require("../services/bookingScheduler");

const toMinutes = (ms) => ms / (60 * 1000);

const normalizeString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const sanitizeVehicleSnapshotInput = (vehicle) => {
  if (!vehicle || typeof vehicle !== "object") {
    throw new HttpError(400, "vehicle must be an object");
  }

  const model = normalizeString(vehicle.model);
  if (!model) {
    throw new HttpError(400, "vehicle.model is required");
  }

  const plugTypeInput = normalizeString(vehicle.plugType ?? vehicle.plug_type);
  if (!plugTypeInput || !VEHICLE_PLUG_TYPES.includes(plugTypeInput)) {
    throw new HttpError(400, "vehicle.plugType is invalid");
  }

  const batteryInput = vehicle.batteryKwh ?? vehicle.battery_kwh;
  const battery = Number(batteryInput);
  if (Number.isNaN(battery) || battery <= 0) {
    throw new HttpError(400, "vehicle.batteryKwh must be a positive number");
  }

  const payload = {
    model,
    plugType: plugTypeInput,
    batteryKwh: battery,
  };

  const make = normalizeString(vehicle.make);
  if (make) payload.make = make;

  const licensePlate = normalizeString(
    vehicle.licensePlate ?? vehicle.license_plate
  );
  if (licensePlate) payload.licensePlate = licensePlate;

  return payload;
};

const findVehicleForUser = async (userId, vehicleId) => {
  if (!vehicleId) {
    return null;
  }

  const or = [{ id: vehicleId }];
  if (mongoose.Types.ObjectId.isValid(vehicleId)) {
    or.push({ _id: vehicleId });
  }

  return Vehicle.findOne({ userId, $or: or }).lean();
};

const buildVehicleSnapshotFromDoc = (vehicleDoc) => {
  if (!vehicleDoc) {
    return undefined;
  }

  return {
    id: vehicleDoc.id,
    model: vehicleDoc.model,
    plugType: vehicleDoc.plugType,
    batteryKwh: vehicleDoc.batteryKwh,
  };
};

exports.createBooking = asyncHandler(async (req, res) => {
  const { connectorId, slotStart } = req.body;
  const vehicleDetails = req.body.vehicle;
  const vehicleIdInput = normalizeString(
    req.body.vehicleId ?? req.body.vehicle_id
  );
  if (!connectorId || !slotStart) {
    throw new HttpError(400, "connectorId and slotStart are required");
  }

  const userId = ensureRequestUserId(req);

  if (vehicleDetails && vehicleIdInput) {
    throw new HttpError(
      400,
      "Provide either vehicleId or vehicle details, not both"
    );
  }

  const start = new Date(slotStart);
  if (Number.isNaN(start.getTime())) {
    throw new HttpError(400, "Invalid slotStart value");
  }

  const normalizedStart = new Date(start);
  normalizedStart.setSeconds(0, 0);
  const minutes = normalizedStart.getMinutes();
  if (minutes % BOOKING_SLOT_MINUTES !== 0) {
    throw new HttpError(
      400,
      `slotStart must align to ${BOOKING_SLOT_MINUTES}-minute intervals`
    );
  }

  const now = new Date();
  if (
    normalizedStart.getTime() + BOOKING_SLOT_MINUTES * 60000 <=
    now.getTime()
  ) {
    throw new HttpError(400, "Slot must be in the future");
  }

  const slotEnd = new Date(
    normalizedStart.getTime() + BOOKING_SLOT_MINUTES * 60 * 1000
  );
  const checkInDeadline = new Date(
    normalizedStart.getTime() + BOOKING_GRACE_MINUTES * 60 * 1000
  );

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

  let connectorDoc;
  let booking;
  let linkedVehicleDoc;
  let vehicleSnapshot;

  if (vehicleIdInput) {
    linkedVehicleDoc = await findVehicleForUser(userId, vehicleIdInput);
    if (!linkedVehicleDoc) {
      throw new HttpError(404, "Vehicle not found");
    }
    vehicleSnapshot = buildVehicleSnapshotFromDoc(linkedVehicleDoc);
  } else if (vehicleDetails) {
    vehicleSnapshot = sanitizeVehicleSnapshotInput(vehicleDetails);
  }

  try {
    connectorDoc = await Connector.findOneAndUpdate(
      { _id: connectorId, status: "IDLE" },
      { status: "RESERVED" },
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
      ...(linkedVehicleDoc ? { vehicleId: linkedVehicleDoc.id } : {}),
      ...(vehicleSnapshot
        ? {
            vehicle: {
              ...vehicleSnapshot,
              ...(linkedVehicleDoc ? { id: linkedVehicleDoc.id } : {}),
            },
          }
        : {}),
    });
  } catch (err) {
    if (connectorDoc) {
      await Connector.findByIdAndUpdate(connectorDoc._id, { status: "IDLE" });
    }
    throw err;
  }

  scheduleNoShowJob(booking);

  const payload = booking.toObject();

  res.status(201).json({
    message: "Booking created successfully",
    booking: payload,
  });
});

exports.getMyBookings = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const bookings = await Booking.find({ userId })
    .sort({ slotStart: -1 })
    .lean();

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
    throw new HttpError(404, "Booking not found");
  }

  if (booking.status !== BOOKING_STATUS.RESERVED) {
    throw new HttpError(409, "Only reserved bookings can be cancelled");
  }

  booking.status = BOOKING_STATUS.CANCELLED;
  await booking.save();

  cancelNoShowJob(booking._id);

  await Connector.findOneAndUpdate(
    { _id: booking.connectorId, status: "RESERVED" },
    { status: "IDLE" }
  );

  res.json({
    message: "Booking cancelled successfully",
    booking: booking.toObject(),
  });
});
