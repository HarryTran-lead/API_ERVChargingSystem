const EventEmitter = require("events");
const Booking = require("../models/Booking");
const Connector = require("../models/Connector");
const { BOOKING_STATUS } = require("../constants/enums");
const { formatBookingDates } = require("../utils/timezoneHelpers");

const scheduledJobs = new Map();
const schedulerEvents = new EventEmitter();

const autoCancelBooking = async (bookingId) => {
  try {
    const booking = await Booking.findById(bookingId);
    if (!booking) return null;

    if (booking.status !== BOOKING_STATUS.RESERVED) return;

    booking.status = BOOKING_STATUS.NO_SHOW;
    await booking.save();

    await Connector.findOneAndUpdate(
      { _id: booking.connectorId, status: "RESERVED" },
      { status: "IDLE" }
    );

    schedulerEvents.emit("autoCancelled", formatBookingDates(booking));

    return booking;
  } catch (err) {
    console.error("[bookingScheduler] Failed to mark booking as no-show", err);
    throw err;
  }
};

const scheduleNoShowJob = (booking) => {
  const bookingId = booking._id.toString();
  const existing = scheduledJobs.get(bookingId);
  if (existing) {
    clearTimeout(existing);
  }

  const delay = booking.checkInDeadline.getTime() - Date.now();
  if (delay <= 0) {
    setImmediate(() => {
      autoCancelBooking(booking._id).catch((err) => {
        console.error(
          "[bookingScheduler] Immediate auto-cancel failed for booking",
          bookingId,
          err
        );
      });
    });
    return;
  }

  const timer = setTimeout(() => {
    scheduledJobs.delete(bookingId);
    setImmediate(() => {
      autoCancelBooking(booking._id).catch((err) => {
        console.error(
          "[bookingScheduler] Immediate auto-cancel failed for booking",
          bookingId,
          err
        );
      });
    });
  }, delay);

  scheduledJobs.set(bookingId, timer);
};

const cancelNoShowJob = (bookingId) => {
  const key = bookingId.toString();
  const timer = scheduledJobs.get(key);
  if (timer) {
    clearTimeout(timer);
    scheduledJobs.delete(key);
  }
};

module.exports = {
  scheduleNoShowJob,
  cancelNoShowJob,
  autoCancelBooking,
  schedulerEvents,
};
