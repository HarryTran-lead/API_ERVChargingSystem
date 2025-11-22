// cron/autoResetConnectors.js
const cron = require("node-cron");
const Connector = require("../models/Connector");

const FINISHED_AUTO_RESET_MINUTES = Number(
  process.env.CONNECTOR_FINISHED_AUTO_RESET_MINUTES || 5
);

const runAutoReset = async () => {
  try {
    const cutoffTime = new Date();
    cutoffTime.setMinutes(
      cutoffTime.getMinutes() - FINISHED_AUTO_RESET_MINUTES
    );

    const result = await Connector.updateMany(
      {
        status: "FINISHED",
        updatedAt: { $lte: cutoffTime },
      },
      {
        $set: { status: "IDLE" },
      }
    );

    if (result.modifiedCount > 0) {
      console.log(
        `Auto Reset Connectors: Reset ${result.modifiedCount} connector(s) from FINISHED to IDLE`
      );
    }
  } catch (error) {
    console.error("Lỗi auto reset connectors:", error);
  }
};

// Chạy mỗi phút để kiểm tra và reset connectors
cron.schedule("* * * * *", runAutoReset, {
  scheduled: true,
  timezone: "Asia/Ho_Chi_Minh",
});

console.log(
  `Auto Reset Connectors Cron đã lên lịch: Mỗi phút → reset connectors FINISHED sau ${FINISHED_AUTO_RESET_MINUTES} phút`
);
