const router = require('express').Router();
const { protect } = require('../../middlewares/authMiddleware');
const { ROLES } = require('../../constants/enums'); // hoặc tự thay mảng ['driver','staff','admin']
const membershipCtrl = require('../../controllers/membershipController');

router.get('/mine',    protect(['driver','staff','admin']), membershipCtrl.getMine);
router.post('/switch', protect(['driver','staff','admin']), membershipCtrl.switchPlan);
router.post('/purchase', protect(['driver','staff','admin']), membershipCtrl.purchase);


module.exports = router;
