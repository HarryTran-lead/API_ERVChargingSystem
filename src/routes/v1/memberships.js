// src/routes/v1/memberships.js
const router = require('express').Router();
const { protect } = require('../../middlewares/authMiddleware');
const { ROLES } = require('../../constants/enums');
const membershipCtrl = require('../../controllers/membershipController');

// tất cả endpoint đều yêu cầu login
router.use(protect([ROLES.DRIVER, ROLES.STAFF, ROLES.ADMIN]));

router.get('/mine',      membershipCtrl.getMine);
router.post('/switch',   membershipCtrl.switchPlan);
router.post('/purchase', membershipCtrl.purchase);
router.get('/plans',     membershipCtrl.listPlansForUser);

module.exports = router;
