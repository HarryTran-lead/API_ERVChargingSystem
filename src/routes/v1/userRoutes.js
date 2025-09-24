// src/routes/v1/userRoutes.js
const express = require('express');
const router = express.Router();
const userController = require('../../controllers/userController');
const { protect } = require('../../middlewares/authMiddleware');

router.use(protect(['admin']));

router.get('/', userController.getAllUsers);
router.get('/:id', userController.getUser);
router.put('/:id', userController.updateUser);
router.delete('/:id', userController.deleteUser);

module.exports = router;
