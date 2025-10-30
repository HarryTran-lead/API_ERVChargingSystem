const express = require('express');
const router = express.Router();
const feedbackController = require('../../controllers/feedbackController');
const { protect } = require('../../middlewares/authMiddleware');

router.post('/', protect(), feedbackController.createFeedback);
router.get('/me', protect(), feedbackController.getMyFeedbacks);
router.get('/', protect(['admin']), feedbackController.getAllFeedbacks);

module.exports = router;