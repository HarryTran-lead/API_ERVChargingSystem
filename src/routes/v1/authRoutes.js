// src/routes/v1/authRoutes.js
// src/routes/v1/authRoutes.js
const express = require('express');
const router = express.Router();
const authController = require('../../controllers/authController');
const { protect } = require('../../middlewares/authMiddleware');

router.post('/signup', authController.signup);
router.post('/login', authController.login);
router.post('/forgot-password', authController.requestPasswordReset);
router.post('/reset-password', authController.resetPassword);
router.patch('/change-password', protect(), authController.changePassword);
module.exports = router;
