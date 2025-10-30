const express = require('express');
const router = express.Router();

const { protect } = require('../../middlewares/authMiddleware');
const { ROLES } = require('../../constants/enums');
const sessionsController = require('../../controllers/sessionsController');

router.use(protect([ROLES.DRIVER, ROLES.ADMIN, ROLES.STAFF]));

//  Bỏ dòng dưới vì không có handler trong controller
// router.post('/start', sessionsController.startImmediateCharge);

router.post('/:id/stop', sessionsController.stopSession);

module.exports = router;
