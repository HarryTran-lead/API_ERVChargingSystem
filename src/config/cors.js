const cors = require("cors");

// Cấu hình CORS cho Express
const corsOptions = {
  origin: [
    "http://localhost:5173", // Thay đổi theo domain front-end
    // Thêm các domain khác nếu cần
  ],
  // Allow common HTTP methods including PATCH for partial updates
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
   allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

module.exports = cors(corsOptions);
