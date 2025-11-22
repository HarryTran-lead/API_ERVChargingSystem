// src/cron/noShowChecker.js
const cron = require("node-cron");
const Booking = require("../models/Booking");
const Connector = require("../models/Connector");
const { BOOKING_STATUS } = require("../constants/enums");

/**
 * Kiểm tra và cập nhật các booking RESERVED đã quá hạn checkInDeadline
 * Chuyển chúng sang NO_SHOW và release connector về IDLE
 */
const checkAndMarkOverdueBookings = async () => {
  try {
    const now = new Date();
    console.log(`[NoShowChecker] Starting check at ${now.toISOString()}`);

    // Tìm tất cả RESERVED booking có checkInDeadline < now
    const overdueBookings = await Booking.find({
      status: BOOKING_STATUS.RESERVED,
      checkInDeadline: { $lt: now },
    });

    if (overdueBookings.length === 0) {
      console.log("[NoShowChecker] No overdue bookings found");
      return { updated: 0, total: 0 };
    }

    console.log(
      `[NoShowChecker] Found ${overdueBookings.length} overdue bookings`
    );

    let updated = 0;

    for (const booking of overdueBookings) {
      try {
        // Cập nhật booking sang NO_SHOW
        booking.status = BOOKING_STATUS.NO_SHOW;
        await booking.save();

        // Release connector từ RESERVED về IDLE
        await Connector.findOneAndUpdate(
          { _id: booking.connectorId, status: "RESERVED" },
          { status: "IDLE" }
        );

        updated++;
        console.log(
          `[NoShowChecker] Marked booking ${booking._id} (checkInDeadline: ${booking.checkInDeadline.toISOString()}) as NO_SHOW`
        );
      } catch (err) {
        console.error(
          `[NoShowChecker] Error updating booking ${booking._id}:`,
          err.message
        );
      }
    }

    console.log(
      `[NoShowChecker] Completed: ${updated}/${overdueBookings.length} bookings updated`
    );
    return { updated, total: overdueBookings.length };
  } catch (error) {
    console.error("[NoShowChecker] Fatal error:", error);
    throw error;
  }
};

/**
 * Chạy mỗi 1 phút để check booking quá hạn
 * Có thể tăng lên 5-10 phút nếu muốn reduce DB load
 */
cron.schedule("* * * * *", checkAndMarkOverdueBookings, {
  scheduled: true,
  timezone: "Asia/Ho_Chi_Minh",
});

console.log(
  "[NoShowChecker] Cron job registered: runs every 1 minute to check overdue bookings"
);

module.exports = {
  checkAndMarkOverdueBookings,
};
