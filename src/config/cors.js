const cors = require('cors');

// Cấu hình CORS cho Express
const corsOptions = {
    origin: [
        'http://localhost:5173', // Thay đổi theo domain front-end
        // Thêm các domain khác nếu cần
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
};

module.exports = cors(corsOptions);
