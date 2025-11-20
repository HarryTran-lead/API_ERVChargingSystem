const express = require("express");
const router = express.Router();
const sessionsController = require("../../controllers/sessionsController");
const { protect } = require("../../middlewares/authMiddleware");
const { ROLES } = require("../../constants/enums");

router.use(protect([ROLES.DRIVER, ROLES.ADMIN, ROLES.STAFF]));

router.post("/start", sessionsController.startImmediateCharge);
router.post("/:id/stop", sessionsController.stopSession);
router.get("/:id", sessionsController.getSession);
router.get('/', sessionsController.listSessions);

module.exports = router;
