require('dotenv').config();

// Fallback nếu không có TZ trong .env
process.env.TZ = process.env.TZ || 'Asia/Ho_Chi_Minh';

const express = require('express');
const http = require('http');
const connectDB = require('./config/mongodb');

const errorHandler = require('./middlewares/errorHandler');
const { setupSocketServer } = require('./sockets');

const payment = require('./controllers/paymentController');

const app = express();
const server = http.createServer(app);

// socket.io
setupSocketServer(server);

// connect DB
connectDB();

// CORS
app.use(require('./config/cors'));

// PayOS webhook: PHẢI đặt TRƯỚC express.json()
app.post(
  '/api/v1/payments/payos/webhook',
  express.raw({ type: 'application/json' }),
  payment.payosWebhook
);

// Các route khác mới dùng JSON parser
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // nếu bạn đôi khi gửi x-www-form-urlencoded

// Routes app
app.use('/api/v1/auth', require('./routes/v1/authRoutes'));
app.use('/api/v1/users', require('./routes/v1/userRoutes'));
app.use('/api/v1/stations', require('./routes/v1/stationsRoutes'));
app.use('/api/v1/connectors', require('./routes/v1/connectorsRoutes'));
app.use('/api/v1/wallets', require('./routes/v1/walletRoutes'));
app.use('/api/v1/tariffs', require('./routes/v1/tariffsRoutes'));
app.use('/api/v1/payments', require('./routes/v1/paymentRoutes')); // KHÔNG định nghĩa /payos/webhook trong file này
app.use('/api/v1/bookings', require('./routes/v1/bookingsRoutes'));
app.use('/api/v1/sessions', require('./routes/v1/sessionsRoutes'));
app.use('/api/v1/vehicles', require('./routes/v1/vehicleRoutes'));
app.use("/api/v1/chargers", require("./routes/v1/chargersRoutes"));
app.use('/api/v1/feedbacks', require('./routes/v1/feedbackRoutes'));
app.use('/api/v1/analytics', require('./routes/v1/analytics'));
app.use('/api/v1/notifications', require('./routes/v1/notificationRoutes'));

app.use('/api/v1/memberships', require('./routes/v1/memberships'));
app.use('/api/v1/admin/membership-plans', require('./routes/v1/adminMembershipPlans'));

app.use('/api/v1/analytics', require('./routes/v1/analyticsRoutes'));
app.use('/api/v1/invoices', require('./routes/v1/invoiceRoutes'));

//  Thêm route admin ví/giao dịch
app.use('/api/v1/admin/wallet', require('./routes/v1/walletAdminRoutes'));

app.use('/api/v1/admin', require('./routes/v1/adminRoutes'));
app.use('/api/v1/staff', require('./routes/v1/staffRoutes'));
// 404 fallback
app.use((req, res) => {
  res.status(404).json({
    success: false,
    status: 404,
    message: `Cannot ${req.method} ${req.originalUrl}`,
  });
});

// Error handler (phải đặt cuối cùng)
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
