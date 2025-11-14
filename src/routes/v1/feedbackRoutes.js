const express = require('express');
const router = express.Router();
const feedbackController = require('../../controllers/feedbackController');
const { protect } = require('../../middlewares/authMiddleware');

router.post('/', protect(), feedbackController.createFeedback);
router.get('/me', protect(), feedbackController.getMyFeedbacks);
router.get('/', protect(['admin', 'staff']), feedbackController.getAllFeedbacks);
router.get('/:id', protect(['admin', 'staff']), feedbackController.getFeedbackById);
router.patch('/:id', protect(['admin', 'staff']), feedbackController.updateFeedback);
module.exports = router;