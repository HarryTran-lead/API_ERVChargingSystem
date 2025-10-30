// src/routes/v1/invoiceRoutes.js
const r = require('express').Router();
const { protect } = require('../../middlewares/authMiddleware');
const { ROLES } = require('../../constants/enums');

const mod = require('../../controllers/invoiceController');
const ctrl = mod?.default || mod; // hỗ trợ cả ESM lẫn CJS

// Admin xem/sửa hóa đơn
r.use(protect([ROLES.ADMIN]));

r.get('/',    ctrl.listInvoices);   // GET  /api/v1/invoices
r.get('/:id', ctrl.getInvoice);     // GET  /api/v1/invoices/:id
r.patch('/:id', ctrl.updateInvoice);// PATCH /api/v1/invoices/:id

module.exports = r;
