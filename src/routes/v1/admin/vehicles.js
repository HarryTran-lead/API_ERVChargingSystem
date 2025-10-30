const router = require('express').Router();
const controller = require('../../../controllers/admin/vehiclesController');

router.get('/', controller.listVehicles);
router.get('/:id', controller.getVehicle);
router.patch('/:id', controller.updateVehicle);
router.delete('/:id', controller.deleteVehicle);
router.post('/:id/restore', controller.restoreVehicle);

module.exports = router;