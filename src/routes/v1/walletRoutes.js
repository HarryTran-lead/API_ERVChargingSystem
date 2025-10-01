// src/routes/v1/walletRoutes.js
const express = require('express');
const router = express.Router();
const { protect } = require('../../middlewares/authMiddleware');
const walletController = require('../../controllers/walletController');
const paymentController = require('../../controllers/paymentController');

router.get('/me', protect(), walletController.getMyWallet);

module.exports = router;
