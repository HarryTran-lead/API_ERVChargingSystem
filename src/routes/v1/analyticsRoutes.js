const express = require("express");
const router = express.Router();
const controller = require("../../controllers/analyticsController");
const { protect } = require("../../middlewares/authMiddleware");
const { ROLES } = require("../../constants/enums");

// Driver-only analytics for self
router.use(protect([ROLES.DRIVER, ROLES.ADMIN]));

router.get("/me/monthly-costs", controller.getMyMonthlyCosts);
router.get("/me/habits", controller.getMyChargingHabits);

module.exports = router;
