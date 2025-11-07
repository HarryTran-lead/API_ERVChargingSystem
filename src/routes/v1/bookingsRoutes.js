const router = require("express").Router();
const { protect } = require("../../middlewares/authMiddleware");
const { ROLES } = require("../../constants/enums");

const mod = require("../../controllers/bookingsController"); // đúng tên file controller
const controller = mod.default || mod;

router.use(protect([ROLES.DRIVER, ROLES.ADMIN, ROLES.STAFF]));

// 1) Các route tĩnh/đặc thù để TRƯỚC route động :id
router.get("/me", controller.getMyBookings); // GET /api/v1/admin/bookings/me
router.get("/available-slots", controller.getAvailableSlots); // GET /api/v1/admin/bookings/available-slots

// 2) Tạo & liệt kê
router.get("/", controller.listBookings); // GET /api/v1/admin/bookings
router.post("/", controller.createBooking); // POST /api/v1/admin/bookings

// 3) Hành động theo id (ưu tiên path cụ thể trước)
router.post("/:id/cancel", controller.cancelBooking); // POST /api/v1/admin/bookings/:id/cancel
router.patch("/:id/status", controller.updateBookingStatus); // PATCH /api/v1/admin/bookings/:id/status

// 4) Cuối cùng mới là đọc theo id; dùng regex để tránh nuốt path tĩnh
router.get("/:id", controller.getBooking); // GET /api/v1/admin/bookings/:id

router.post("/", controller.createBooking);
router.get("/me", controller.getMyBookings);
router.get("/available-slots", controller.getAvailableSlots);
router.delete("/:id", controller.cancelBooking);

module.exports = router;
