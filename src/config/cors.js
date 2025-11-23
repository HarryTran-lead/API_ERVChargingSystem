const cors = require("cors");

// Cấu hình CORS cho Express
const corsOptions = {
  origin: [
    "http://localhost:5173", // Dev local
    "https://fe-electric-vehicle-dealer-manageme.vercel.app", // Production frontend
    // Thêm các domain khác nếu cần
  ],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  credentials: true,
};

module.exports = cors(corsOptions);
