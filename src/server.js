// server.js
require('dotenv').config();
const express = require('express');
const connectDB = require('./config/mongodb');
const errorHandler = require('./middlewares/errorHandler');
const payment = require('./controllers/paymentController');

const app = express();
connectDB();

// PayOS webhook: phải đặt TRƯỚC express.json()
app.all(
  '/api/v1/payments/payos/webhook',
  (req, _res, next) => { console.log('[WEBHOOK HIT]', req.method, req.originalUrl); next(); },
  express.raw({ type: '*/*' }),
  payment.payosWebhook
);

// Các route khác mới dùng JSON parser
app.use(express.json());

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

// 404 cuối cùng
app.use((req, res) => {
  res.status(404).json({ success: false, status: 404, message: `Cannot ${req.method} ${req.originalUrl}` });
});

// Error handler cuối cùng
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
