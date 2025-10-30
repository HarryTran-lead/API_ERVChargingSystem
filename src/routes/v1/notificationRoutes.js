const router = require('express').Router();
const { protect } = require('../../middlewares/authMiddleware');
const controller = require('../../controllers/notificationController');

router.use(protect());

router.get('/', controller.listMyNotifications);
router.patch('/read-all', controller.markAllNotificationsRead);
router.patch('/:id/read', controller.markNotificationRead);

module.exports = router;