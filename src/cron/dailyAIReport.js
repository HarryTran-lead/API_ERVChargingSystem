// cron/dailyAIReport.js
const cron = require("node-cron");
const { aiInfrastructureForecast } = require("../controllers/aiController");
const AIReport = require("../models/AIReport");

const runAndSaveDailyReport = async () => {
  console.log("AI Cron: Bắt đầu tạo báo cáo lúc 00:00");

  try {
    const fakeReq = { query: { period: "last_6_months" } };
    const fakeRes = {
      data: null,
      status: () => ({
        json: (d) => {
          fakeRes.data = d;
        },
      }),
    };

    await aiInfrastructureForecast(fakeReq, fakeRes);
    const result = fakeRes.data.data;

    // Lưu vào DB
    await AIReport.create({
      period: result.period,
      summary: result.summary,
      aiInsight: result.aiInsight,
      rawDataSample: result.rawDataSample,
    });

    console.log("AI báo cáo đã lưu vào DB:", new Date());
  } catch (error) {
    console.error("Lỗi lưu báo cáo AI:", error);
  }
};

// Chạy lúc 00:00 hàng ngày (giờ VN)
cron.schedule("0 0 * * *", runAndSaveDailyReport, {
  scheduled: true,
  timezone: "Asia/Ho_Chi_Minh",
});

console.log("AI Cron Job đã lên lịch: 00:00 hàng ngày → lưu DB");
