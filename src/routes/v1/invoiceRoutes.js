const r = require("express").Router();
const { protect } = require("../../middlewares/authMiddleware");
const ctrl = require("../../controllers/invoiceController");

// Driver: xem danh sách hóa đơn và thanh toán
r.use(protect(["driver", "admin"]));
r.get("/me", ctrl.listMyInvoices);
r.get("/:id", ctrl.getInvoice);
r.post("/:id/pay", ctrl.payInvoice);

module.exports = r;
