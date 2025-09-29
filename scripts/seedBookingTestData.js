#!/usr/bin/env node
require("dotenv").config();

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const connectDB = require("../src/config/mongodb");
const User = require("../src/models/User");
const Wallet = require("../src/models/Wallet");
const Station = require("../src/models/Station");
const Connector = require("../src/models/Connector");

const DRIVER_EMAIL = "driver.booking@example.com";
const DRIVER_PASSWORD = "Driver@123";
const STATION_NAME = "Downtown Sample Station";
const CONNECTOR_CODE = "CONN-01";

(async () => {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI is required in environment variables");
    }
    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET is required in environment variables");
    }

    await connectDB();

    let user = await User.findOne({ email: DRIVER_EMAIL });
    if (!user) {
      const password_hash = await bcrypt.hash(DRIVER_PASSWORD, 10);
      user = await User.create({
        name: "Sample Booking Driver",
        email: DRIVER_EMAIL,
        password_hash,
        role: "driver",
      });
      console.log(`Created driver user ${DRIVER_EMAIL}`);
    }

    let wallet = await Wallet.findOne({ user_id: user.id });
    if (!wallet) {
      wallet = await Wallet.create({ user_id: user.id, balance: 500000 });
      console.log("Created wallet with initial balance 500,000 VND");
    } else if (wallet.balance < 500000) {
      wallet.balance = 500000;
      wallet.updated_at = new Date();
      await wallet.save();
      console.log("Updated wallet balance to 500,000 VND");
    }

    let station = await Station.findOne({ name: STATION_NAME });
    if (!station) {
      station = await Station.create({
        name: STATION_NAME,
        lat: 10.7769,
        lng: 106.7009,
        status: "ONLINE",
      });
      console.log(`Created sample station: ${STATION_NAME}`);
    }

    let connector = await Connector.findOne({
      stationId: station._id,
      code: CONNECTOR_CODE,
    });
    if (!connector) {
      connector = await Connector.create({
        stationId: station._id,
        type: "CCS2",
        powerKw: 120,
        status: "IDLE",
        code: CONNECTOR_CODE,
      });
      console.log(`Created connector ${CONNECTOR_CODE} in IDLE status`);
    } else if (connector.status !== "IDLE") {
      connector.status = "IDLE";
      await connector.save();
      console.log("Reset connector status back to IDLE");
    }

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    console.log("\nTest data ready! Use the following details:");
    console.log("--------------------------------------------------");
    console.log(`Driver login email: ${DRIVER_EMAIL}`);
    console.log(`Driver login password: ${DRIVER_PASSWORD}`);
    console.log(`Auth token: ${token}`);
    console.log("\nSample booking request:");
    console.log("POST /api/v1/bookings");
    console.log("Headers: Authorization: Bearer <Auth token above>");
    const slotStart = new Date(Date.now() + 30 * 60000);
    slotStart.setSeconds(0, 0);

    console.log(
      JSON.stringify(
        {
          connectorId: connector._id,
          slotStart: slotStart.toISOString(),
        },
        null,
        2
      )
    );
    console.log("\nConnector and station identifiers:");
    console.log(`stationId: ${station._id}`);
    console.log(`connectorId: ${connector._id}`);
  } catch (err) {
    console.error("Failed to seed booking test data", err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close().catch(() => {});
    setTimeout(() => process.exit(), 50);
  }
})();
