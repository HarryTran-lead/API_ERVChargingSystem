const router = require('express').Router();
const controller = require('../../../controllers/admin/sessionsController');

router.get('/', controller.listSessions);
router.get('/:id', controller.getSession);
router.post('/:id/stop', controller.stopSession);

module.exports = router;