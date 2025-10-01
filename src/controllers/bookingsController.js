const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Connector = require("../models/Connector");
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

const toMinutes = (ms) => ms / (60 * 1000);

exports.createBooking = asyncHandler(async (req, res) => {
  const { connectorId, slotStart } = req.body;
  if (!connectorId || !slotStart) {
    throw new HttpError(400, "connectorId and slotStart are required");
  }

  const userId = ensureRequestUserId(req);

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
