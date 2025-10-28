const router = require('express').Router();
const { protect } = require('../../middlewares/authMiddleware');
// hoặc dùng ROLES nếu bạn đã export: const { ROLES } = require('../../constants/enums');
const membershipCtrl = require('../../controllers/membershipController');

// tất cả endpoint đều yêu cầu login
router.use(protect(['driver','staff','admin']));

router.get('/mine',        membershipCtrl.getMine);
router.post('/switch',     membershipCtrl.switchPlan);
router.post('/purchase',   membershipCtrl.purchase);
router.get('/plans',       membershipCtrl.listPlansForUser); // cần req.user
router.get('/plans/:code', membershipCtrl.getPlanPublic);

module.exports = router;
