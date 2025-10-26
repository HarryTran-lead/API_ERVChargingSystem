// src/routes/v1/walletRoutes.js
const express = require('express');
const router = express.Router();
const { protect } = require('../../middlewares/authMiddleware');
const walletController = require('../../controllers/walletController');
const paymentController = require('../../controllers/paymentController');
router.use(protect(['driver','staff','admin']));

router.get('/me', protect(), walletController.getMyWallet);
router.get('/transactions', walletController.listMyTransactions); // <-- lịch sử giao dịch

module.exports = router;
