const express = require('express');
const router = express.Router();
const profileController = require('../../controllers/profileController');
const { protect } = require('../../middlewares/authMiddleware');

// GET /api/v1/profile -> returns current authenticated user's profile
router.get('/', protect(), profileController.getProfile);

// PATCH /api/v1/profile -> update current user's profile (name, phone)
router.patch('/', protect(), profileController.updateProfile);

module.exports = router;
