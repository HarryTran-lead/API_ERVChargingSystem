require('dotenv').config();
const express = require('express');
const connectDB = require('./config/mongodb');
const payment = require('./controllers/paymentController');

const app = express();
connectDB();

// PayOS webhook: PHẢI đặt TRƯỚC express.json()
app.post('/api/v1/payments/payos/webhook',
  express.raw({ type: 'application/json' }),
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
app.use('/api/v1/payments', require('./routes/v1/paymentRoutes')); // KHÔNG khai báo webhook ở file routes nữa

// 404
app.use((req, res) => res.status(404).send(`Cannot ${req.method} ${req.originalUrl}`));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
