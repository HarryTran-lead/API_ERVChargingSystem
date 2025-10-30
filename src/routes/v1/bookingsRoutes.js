// src/routes/v1/admin/bookings.js  (đặt đúng nhánh admin)
const router = require('express').Router();
const { protect } = require('../../middlewares/authMiddleware');
const { ROLES } = require('../../constants/enums');

const mod = require('../../controllers/bookingsController'); // file bạn gửi
const controller = mod.default || mod;

router.use(protect([ROLES.ADMIN]));

router.get('/', controller.listBookings);              // GET /api/v1/admin/bookings
router.get('/:id', controller.getBooking);             // GET /api/v1/admin/bookings/:id
router.patch('/:id/status', controller.updateBookingStatus); // PATCH /api/v1/admin/bookings/:id/status

module.exports = router;
