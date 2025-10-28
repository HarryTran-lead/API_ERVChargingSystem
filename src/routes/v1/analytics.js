// routes/v1/analytics.js
const express = require('express');
const router = express.Router();

const controller = require('../../controllers/analyticsController');
const { protect } = require('../../middlewares/authMiddleware');
const { ROLES } = require('../../constants/enums');

// Admin-only
router.get('/admin/overview', protect([ROLES.ADMIN]), controller.getAdminOverview);

// Driver/Admin self analytics
router.use('/me', protect([ROLES.DRIVER, ROLES.ADMIN]));
router.get('/me/monthly-costs', controller.getMyMonthlyCosts);
router.get('/me/habits', controller.getMyChargingHabits);

module.exports = router;
