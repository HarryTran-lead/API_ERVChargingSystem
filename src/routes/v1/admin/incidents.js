const router = require('express').Router();
const controller = require('../../../controllers/admin/incidentsController');

router.get('/', controller.listIncidentReports);
router.patch('/:id/in-progress', controller.markIncidentInProgress);

module.exports = router;