// src/routes/v1/walletAdminRoutes.js
const express = require('express');
const router = express.Router();

const { protect } = require('../../middlewares/authMiddleware');
const walletAdminController = require('../../controllers/walletAdminController');

// BẮT BUỘC ADMIN
router.use(protect(['admin']));

// 1) Admin xem ví + giao dịch của 1 user cụ thể
//    GET /api/v1/admin/wallet/user?userId=...&from=...&to=...&type=...&page=1&limit=20
router.get('/user', walletAdminController.getUserWalletAndTransactions);

// 2) ✅ Admin xem tất cả giao dịch trong hệ thống (có thể lọc)
//    GET /api/v1/admin/wallet/transactions?type=TOPUP&from=...&to=...&page=1&limit=50
//    (userId=? là optional để lọc 1 người)
router.get('/transactions', walletAdminController.listAllTransactionsAdmin);

module.exports = router;
