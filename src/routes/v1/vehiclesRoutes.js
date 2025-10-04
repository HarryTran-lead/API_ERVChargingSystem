const router = require("express").Router();
const { protect } = require("../../middlewares/authMiddleware");
const { ROLES } = require("../../constants/enums");
const vehiclesController = require("../../controllers/vehiclesController");

// Drivers manage their own vehicles. Admins can support users when needed.
router.post(
  "/",
  protect([ROLES.ADMIN, ROLES.DRIVER]),
  vehiclesController.createVehicle
);
router.get(
  "/",
  protect([ROLES.ADMIN, ROLES.DRIVER]),
  vehiclesController.listMyVehicles
);
router.get(
  "/:id",
  protect([ROLES.ADMIN, ROLES.DRIVER]),
  vehiclesController.getVehicle
);
router.put(
  "/:id",
  protect([ROLES.ADMIN, ROLES.DRIVER]),
  vehiclesController.updateVehicle
);
router.delete(
  "/:id",
  protect([ROLES.ADMIN, ROLES.DRIVER]),
  vehiclesController.deleteVehicle
);

module.exports = router;
