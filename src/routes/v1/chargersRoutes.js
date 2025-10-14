const router = require("express").Router();
const { protect } = require("../../middlewares/authMiddleware");
const { ROLES } = require("../../constants/enums");
const C = require("../../controllers/chargersController");

router.post("/", protect([ROLES.ADMIN]), C.createCharger);
router.get("/", protect([ROLES.ADMIN, ROLES.STAFF]), C.listChargers);
router.get("/:id", protect([ROLES.ADMIN, ROLES.STAFF]), C.getCharger);
router.put("/:id", protect([ROLES.ADMIN]), C.updateCharger);
router.delete("/:id", protect([ROLES.ADMIN]), C.deleteCharger);
router.get(
  "/scan/:token",
  protect([ROLES.ADMIN, ROLES.STAFF, ROLES.DRIVER]),
  C.getChargerScanDetails
);
module.exports = router;
