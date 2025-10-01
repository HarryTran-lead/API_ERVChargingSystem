// src/controllers/invoiceController.js
const Invoice = require('../models/Invoice')
exports.getInvoice = async (req, res) => {
  const inv = await Invoice.findOne({ id: req.params.id })
  if (!inv) return res.status(404).json({ msg: 'Invoice not found' })
  res.json(inv)
}

// src/routes/v1/invoiceRoutes.js
const r = require('express').Router()
const { protect } = require('../../middlewares/authMiddleware')
const ctrl = require('../../controllers/invoiceController')
r.get('/:id', protect(['driver','staff','admin']), ctrl.getInvoice)
module.exports = r
