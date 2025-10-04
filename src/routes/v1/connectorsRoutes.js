const router = require("express").Router();
const { protect } = require("../../middlewares/authMiddleware");
const { ROLES } = require("../../constants/enums");
const C = require("../../controllers/connectorsController");

// ADMIN tạo/sửa/xoá; STAFF xem (và có thể bật/tắt nếu bạn muốn cho phép)
router.post("/", protect([ROLES.ADMIN]), C.createConnector);
router.get(
  "/",
  protect([ROLES.ADMIN, ROLES.STAFF, ROLES.DRIVER]),
  C.listConnectors
);
router.get(
  "/:id",
  protect([ROLES.ADMIN, ROLES.STAFF, ROLES.DRIVER]),
  C.getConnector
);
router.put("/:id", protect([ROLES.ADMIN]), C.updateConnector);
router.patch(
  "/:id/status",
  protect([ROLES.ADMIN, ROLES.STAFF]),
  C.patchConnectorStatus
);
router.delete("/:id", protect([ROLES.ADMIN]), C.deleteConnector);
router.get(
  "/scan/:token",
  protect([ROLES.ADMIN, ROLES.STAFF, ROLES.DRIVER]),
  C.getConnectorScanDetails
);
module.exports = router;
