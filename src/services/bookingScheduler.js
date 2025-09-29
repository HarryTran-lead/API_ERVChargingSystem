const Booking = require("../models/Booking");
const Connector = require("../models/Connector");
const { BOOKING_STATUS } = require("../constants/enums");

const scheduledJobs = new Map();

const runNoShow = async (bookingId) => {
  try {
    const booking = await Booking.findById(bookingId);
    if (!booking) return;

    if (booking.status !== BOOKING_STATUS.RESERVED) return;

    booking.status = BOOKING_STATUS.NO_SHOW;
    await booking.save();

    await Connector.findByIdAndUpdate(booking.connectorId, { status: "IDLE" });
  } catch (err) {
    console.error("[bookingScheduler] Failed to mark booking as no-show", err);
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
    setImmediate(() => runNoShow(booking._id));
    return;
  }

  const timer = setTimeout(() => {
    scheduledJobs.delete(bookingId);
    runNoShow(booking._id);
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
};
