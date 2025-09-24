// src/routes/tariffs.routes.js
const router = require("express").Router();
const { protect } = require("../../middlewares/authMiddleware");
const { ROLES } = require("../../constants/enums");
const C = require("../../controllers/tariffsController");

router.post("/", protect([ROLES.ADMIN]), C.createTariff);
router.get("/", protect([ROLES.ADMIN, ROLES.STAFF, ROLES.DRIVER]), C.listTariffs);
router.get("/effective", protect([ROLES.ADMIN, ROLES.STAFF, ROLES.DRIVER]), C.getEffectiveTariff);
router.get("/min-required", protect([ROLES.ADMIN, ROLES.STAFF, ROLES.DRIVER]), C.getMinRequired);
router.get("/:id", protect([ROLES.ADMIN, ROLES.STAFF, ROLES.DRIVER]), C.getTariff);
router.put("/:id", protect([ROLES.ADMIN]), C.updateTariff);
router.delete("/:id", protect([ROLES.ADMIN]), C.deleteTariff);

module.exports = router;
