const router = require('express').Router();
const controller = require('../../../controllers/admin/invoicesController');

router.get('/', controller.listInvoices);
router.get('/:id', controller.getInvoice);
router.patch('/:id', controller.updateInvoice);

module.exports = router;