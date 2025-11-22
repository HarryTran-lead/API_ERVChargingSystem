const express = require('express');
const router = express.Router();
const contactController = require('../../controllers/contactController');
const { protect, optionalAuth } = require('../../middlewares/authMiddleware');

router.post('/', optionalAuth(), contactController.createContactMessage);
router.get('/', protect(['admin', 'staff']), contactController.getContactMessages);
router.get('/:id', protect(['admin', 'staff']), contactController.getContactMessageById);
router.patch('/:id', protect(['admin', 'staff']), contactController.updateContactMessage);

module.exports = router;