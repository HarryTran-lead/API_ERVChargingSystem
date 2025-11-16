const express = require('express');
const router = express.Router();
const profileController = require('../../controllers/profileController');
const { protect } = require('../../middlewares/authMiddleware');

// GET /api/v1/profile -> current authenticated user
router.get('/', protect(), profileController.getProfile);

// PATCH /api/v1/profile -> update current authenticated user
router.patch('/', protect(), profileController.updateProfile);

module.exports = router;
