require('dotenv').config();
const express = require('express');
const http = require("http");
const connectDB = require('./config/mongodb');

require('dotenv').config();
const errorHandler = require("./middlewares/errorHandler");
const { setupSocketServer } = require("./sockets");

const payment = require('./controllers/paymentController');


const app = express();
const server = http.createServer(app);
setupSocketServer(server);
connectDB();
// CORS
app.use(require("./config/cors"));
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
app.use("/api/v1/bookings", require("./routes/v1/bookingsRoutes"));
app.use("/api/v1/vehicles", require("./routes/v1/vehiclesRoutes"));
app.use("/api/v1/sessions", require("./routes/v1/sessionsRoutes"));
app.use("/api/v1/chargers", require("./routes/v1/chargersRoutes"));

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
