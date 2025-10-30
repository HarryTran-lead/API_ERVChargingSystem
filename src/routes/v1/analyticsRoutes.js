// src/routes/v1/analyticsRoutes.js
const express = require('express');
const router = express.Router();

const controller = require('../../controllers/analyticsController');
const { protect } = require('../../middlewares/authMiddleware');
const { ROLES } = require('../../constants/enums');

// Admin-only analytics
router.get(
  '/admin/overview',
  protect([ROLES.ADMIN]),
  controller.getAdminOverview
);

// Driver/Admin self analytics (scope middleware only to /me/*)
router.use('/me', protect([ROLES.DRIVER, ROLES.ADMIN]));
router.get('/me/monthly-costs', controller.getMyMonthlyCosts);
router.get('/me/habits', controller.getMyChargingHabits);

module.exports = router;
