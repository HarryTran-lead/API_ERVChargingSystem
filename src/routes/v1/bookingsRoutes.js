const express = require("express");
const router = express.Router();
const bookingsController = require("../../controllers/bookingsController");
const { protect } = require("../../middlewares/authMiddleware");
const { ROLES } = require("../../constants/enums");

router.use(protect([ROLES.DRIVER, ROLES.ADMIN, ROLES.STAFF]));

router.post("/", bookingsController.createBooking);
router.get("/me", bookingsController.getMyBookings);
router.delete("/:id", bookingsController.cancelBooking);

module.exports = router;
