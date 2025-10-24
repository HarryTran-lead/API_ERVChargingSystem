const router = require("express").Router();
const { protect } = require("../../middlewares/authMiddleware");
const { ROLES } = require("../../constants/enums");
const C = require("../../controllers/stationsController");

router.post("/", protect([ROLES.ADMIN]), C.createStation);
router.get(
  "/all",
  protect([ROLES.ADMIN, ROLES.STAFF, ROLES.DRIVER]),
  C.listStationsWithAssets
);
router.get("/", protect([ROLES.ADMIN, ROLES.STAFF, ROLES.DRIVER]), C.listStations);
router.get("/:id", protect([ROLES.ADMIN, ROLES.STAFF, ROLES.DRIVER]), C.getStation);
router.put("/:id", protect([ROLES.ADMIN]), C.updateStation);
router.delete("/:id", protect([ROLES.ADMIN]), C.deleteStation);


module.exports = router;
