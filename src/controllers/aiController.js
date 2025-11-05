// controllers/aiController.js
const { GoogleGenerativeAI } = require("@google/generative-ai");
const mongoose = require("mongoose");
const Session = require("../models/Session");
const Booking = require("../models/Booking");
const Station = require("../models/Station");
const Connector = require("../models/Connector");

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { responseMimeType: "application/json" }, // Yêu cầu JSON output
});

const aiInfrastructureForecast = async (req, res) => {
  try {
    const { stationId, period = "last_6_months" } = req.query;

    // 1. Xác định khoảng thời gian
    const { startDate, endDate } = getDateRange(period);

    // 2. Aggregation: Dữ liệu thực tế từ Session + Booking
    const sessionPipeline = [
      {
        $match: {
          status: { $in: ["COMPLETED", "STOPPED"] },
          startedAt: { $gte: startDate, $lte: endDate },
          ...(stationId && {
            stationId: new mongoose.Types.ObjectId(stationId),
          }),
        },
      },
      {
        $lookup: {
          from: "connectors",
          localField: "connectorId",
          foreignField: "_id",
          as: "connector",
        },
      },
      { $unwind: "$connector" },
      {
        $lookup: {
          from: "stations",
          localField: "stationId",
          foreignField: "_id",
          as: "station",
        },
      },
      { $unwind: "$station" },
      {
        $group: {
          _id: {
            stationId: "$stationId",
            stationName: "$station.name",
            lat: "$station.lat",
            lng: "$station.lng",
            connectorType: "$connector.type",
            month: { $dateToString: { format: "%Y-%m", date: "$startedAt" } },
            hour: { $hour: "$startedAt" },
          },
          sessionsCount: { $sum: 1 },
          totalEnergyKwh: { $sum: "$billing.breakdown.energyKwh" },
          avgChargingMinutes: { $avg: "$totalChargingMinutes" },
          peakHours: { $addToSet: "$hour" },
        },
      },
      {
        $project: {
          _id: 0,
          stationId: "$_id.stationId",
          stationName: "$_id.stationName",
          lat: "$_id.lat",
          lng: "$_id.lng",
          connectorType: "$_id.connectorType",
          month: "$_id.month",
          sessionsCount: 1,
          totalEnergyKwh: { $round: ["$totalEnergyKwh", 2] },
          avgChargingMinutes: { $round: ["$avgChargingMinutes", 1] },
          peakHours: {
            $setUnion: [
              {
                $filter: { input: "$peakHours", cond: { $gte: ["$$this", 0] } },
              },
              [],
            ],
          },
        },
      },
      { $sort: { month: 1, sessionsCount: -1 } },
    ];

    const bookingPipeline = [
      {
        $match: {
          status: { $in: ["RESERVED", "ACTIVE", "COMPLETED"] },
          slotStart: { $gte: startDate, $lte: endDate },
          ...(stationId && {
            stationId: new mongoose.Types.ObjectId(stationId),
          }),
        },
      },
      {
        $group: {
          _id: {
            stationId: "$stationId",
            month: { $dateToString: { format: "%Y-%m", date: "$slotStart" } },
          },
          bookingCount: { $sum: 1 },
        },
      },
    ];

    const [sessionData, bookingData] = await Promise.all([
      Session.aggregate(sessionPipeline),
      Booking.aggregate(bookingPipeline),
    ]);

    // Gộp dữ liệu
    const mergedData = mergeSessionAndBookingData(sessionData, bookingData);

    if (mergedData.length === 0) {
      return res.status(200).json({
        success: true,
        message: "Không có dữ liệu để phân tích",
        data: null,
      });
    }

    // 3. Prompt thông minh cho Gemini
    const prompt = `
Bạn là chuyên gia phân tích dữ liệu trạm sạc xe điện. Dựa trên dữ liệu thực tế sau (JSON), hãy:

1. Phân tích xu hướng sử dụng (số phiên sạc, năng lượng, giờ cao điểm)
2. Dự báo nhu cầu 3 tháng tới (số phiên, kWh, giờ cao điểm)
3. Đưa ra gợi ý nâng cấp hạ tầng: thêm connector loại nào, ở đâu, ưu tiên theo tải và vị trí

Dữ liệu (mỗi object là 1 connector-type tại 1 station trong 1 tháng):
\`\`\`json
${JSON.stringify(mergedData.slice(0, 30), null, 2)}  // Giới hạn 30 bản ghi để tránh quá dài
\`\`\`

Yêu cầu output JSON:
{
  "analysis": "Mô tả ngắn gọn xu hướng",
  "forecast": {
    "next_3_months": {
      "estimated_sessions": 120,
      "estimated_kwh": 4500,
      "peak_hours": [18, 19, 20]
    }
  },
  "recommendations": [
    "Thêm 2 connector Type 2 tại [Tên trạm] (lat: 10.XX, lng: 106.XX) - tải cao 85%",
    "Nâng cấp nguồn điện tại [Tên trạm] do năng lượng trung bình > 80 kWh/ngày"
  ]
}
`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    let aiResponse;
    try {
      aiResponse = JSON.parse(responseText);
    } catch (e) {
      aiResponse = { raw: responseText };
    }

    res.status(200).json({
      success: true,
      data: {
        period,
        stationId,
        summary: {
          totalSessions: sessionData.reduce(
            (sum, d) => sum + d.sessionsCount,
            0
          ),
          totalKwh: sessionData.reduce((sum, d) => sum + d.totalEnergyKwh, 0),
          stationsAnalyzed: new Set(sessionData.map((d) => d.stationId)).size,
        },
        rawDataSample: mergedData.slice(0, 5),
        aiInsight: aiResponse,
      },
    });
  } catch (error) {
    console.error("AI Forecast Error:", error);
    res.status(500).json({
      success: false,
      message: "Lỗi khi gọi AI dự báo",
      error: error.message,
    });
  }
};

// Helper: Tạo khoảng thời gian
function getDateRange(period) {
  const endDate = new Date();
  let startDate = new Date();

  switch (period) {
    case "last_3_months":
      startDate.setMonth(endDate.getMonth() - 3);
      break;
    case "last_6_months":
      startDate.setMonth(endDate.getMonth() - 6);
      break;
    case "last_year":
      startDate.setFullYear(endDate.getFullYear() - 1);
      break;
    default:
      startDate.setMonth(endDate.getMonth() - 6);
  }

  return { startDate, endDate };
}

// Helper: Gộp dữ liệu Session + Booking
function mergeSessionAndBookingData(sessionData, bookingData) {
  const bookingMap = {};
  bookingData.forEach((b) => {
    const key = `${b._id.stationId}-${b._id.month}`;
    bookingMap[key] = b.bookingCount;
  });

  return sessionData.map((s) => ({
    ...s,
    bookingCount: bookingMap[`${s.stationId}-${s.month}`] || 0,
  }));
}

module.exports = { aiInfrastructureForecast };
