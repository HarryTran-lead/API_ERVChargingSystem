const express = require('express');
const connectDB = require('./config/mongodb');
require('dotenv').config();
const errorHandler = require("./middlewares/errorHandler");

const app = express();
app.use(express.json());

// Connect DB
connectDB();

// Root route
app.get('/', (req, res) => res.send('API is running'));

// Mount routes
app.use('/api/v1/auth', require('./routes/v1/authRoutes'));
app.use('/api/v1/users', require('./routes/v1/userRoutes'));
app.use('/api/v1/wallets', require('./routes/v1/walletRoutes')); // nếu có walletRoutes
app.use("/api/v1/stations", require("./routes/v1/stationsRoutes"));
app.use("/api/v1/connectors", require("./routes/v1/connectorsRoutes"));
app.use("/api/v1/tariffs", require("./routes/v1/tariffsRoutes"));
app.use("/api/v1/bookings", require("./routes/v1/bookingsRoutes"));
app.use("/api/v1/sessions", require("./routes/v1/sessionsRoutes"));

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
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
