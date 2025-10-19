// routes/v1/vehicleRoutes.js
const router = require('express').Router();
const { protect } = require('../../middlewares/authMiddleware');
const { ROLES } = require('../../constants/enums');
const vehicleCtrl = require('../../controllers/vehicleController');

// Base: /api/v1/vehicles
router.post(
  '/',
  protect([ROLES.DRIVER, ROLES.ADMIN]),
  vehicleCtrl.create
);
router.get(
  '/',
  protect([ROLES.DRIVER, ROLES.ADMIN]),
  vehicleCtrl.listMine
);
router.get(
  '/:vehicleId',
  protect([ROLES.DRIVER, ROLES.ADMIN]),
  vehicleCtrl.getOne
);
router.patch(
  '/:vehicleId',
  protect([ROLES.DRIVER, ROLES.ADMIN]),
  vehicleCtrl.update
);
router.patch(
  '/:vehicleId/default',
  protect([ROLES.DRIVER, ROLES.ADMIN]),
  vehicleCtrl.setDefault
);
router.delete(
  '/:vehicleId',
  protect([ROLES.DRIVER, ROLES.ADMIN]),
  vehicleCtrl.remove
);

module.exports = router;
