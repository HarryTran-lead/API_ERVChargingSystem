// routes/v1/vehicleRoutes.js
const router = require('express').Router();
const { protect } = require('../../middlewares/authMiddleware');
const vehicleCtrl = require('../../controllers/vehicleController');

// base: /api/v1/vehicles
router.post('/',                protect(['driver']), vehicleCtrl.create);
router.get('/',                 protect(['driver']), vehicleCtrl.listMine);
router.get('/:vehicleId',       protect(['driver']), vehicleCtrl.getOne);
router.patch('/:vehicleId',     protect(['driver']), vehicleCtrl.update);
router.patch('/:vehicleId/default', protect(['driver']), vehicleCtrl.setDefault);
router.delete('/:vehicleId',    protect(['driver']), vehicleCtrl.remove);

module.exports = router;
