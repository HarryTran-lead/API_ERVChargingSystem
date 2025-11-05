// src/routes/v1/admin/bookings.js  (đặt đúng nhánh admin)
const router = require('express').Router();
const { protect } = require('../../middlewares/authMiddleware');
const { ROLES } = require('../../constants/enums');

const mod = require('../../controllers/bookingsController'); // file bạn gửi
const controller = mod.default || mod;

router.use(protect([ROLES.DRIVER, ROLES.ADMIN, ROLES.STAFF]));

router.get('/', controller.listBookings);              // GET /api/v1/admin/bookings
router.get('/:id', controller.getBooking);             // GET /api/v1/admin/bookings/:id
router.patch('/:id/status', controller.updateBookingStatus); // PATCH /api/v1/admin/bookings/:id/status

router.post("/", bookingsController.createBooking);
router.get("/me", bookingsController.getMyBookings);
router.get("/available-slots", bookingsController.getAvailableSlots);
router.delete("/:id", bookingsController.cancelBooking);

module.exports = router;
