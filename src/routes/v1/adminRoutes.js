// src/routes/v1/adminRoutes.js
const router = require('express').Router();
const { protect } = require('../../middlewares/authMiddleware');
const { ROLES } = require('../../constants/enums');

// Helper: chấp nhận CJS/ESM và xác thực đúng kiểu middleware/router
function asMiddleware(mod, label) {
  const m = mod && mod.default ? mod.default : mod; // hỗ trợ ESM default export
  if (typeof m === 'function') return m;           // middleware function
  if (m && typeof m === 'object' && typeof m.handle === 'function') return m; // express.Router()
  const got =
    m && m.constructor ? m.constructor.name : Object.prototype.toString.call(m);
  throw new TypeError(
    `Router.use() requires a middleware/Router for "${label}" but got ${got}`
  );
}

// Toàn bộ route dưới đây yêu cầu ADMIN
router.use(protect([ROLES.ADMIN]));

// Mount các nhánh admin (đảm bảo mỗi file export express.Router() hoặc middleware)
router.use('/bookings',        asMiddleware(require('./admin/bookings'),        'admin/bookings'));
router.use('/sessions',        asMiddleware(require('./admin/sessions'),        'admin/sessions'));
router.use('/vehicles',        asMiddleware(require('./admin/vehicles'),        'admin/vehicles'));          // <- SỬA từ "./" thành "./admin/vehicles"
router.use('/invoices',        asMiddleware(require('./admin/invoices'),        'admin/invoices'));
router.use('/membership-plans',asMiddleware(require('./adminMembershipPlans'), './adminMembershipPlans'));   // đổi path nếu file bạn khác
router.use('/wallet',          asMiddleware(require('./walletAdminRoutes'),          './walletAdminRoutes'));            // đổi path nếu file bạn khác
router.use('/incidents',       asMiddleware(require('./admin/incidents'),       'admin/incidents'));
module.exports = router;
