// routes/v1/aiRoutes.js
const express = require("express");
const { aiInfrastructureForecast } = require("../../controllers/aiController");

const router = express.Router();

router.get(
  "/forecast/infrastructure",
  aiInfrastructureForecast
);

module.exports = router;
