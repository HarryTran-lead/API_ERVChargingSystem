const express = require('express');
const router = express.Router();
const { protect } = require('../../middlewares/authMiddleware');

// NÊN import kiểu object và tự check
const ctrl = require('../../controllers/paymentController');

// Ghim vài assert để bắt lỗi ngay khi thiếu export
['initiateTopUpPayOS','payosWebhook','payosReturn','payosCancel'].forEach((k)=>{
  if (typeof ctrl[k] !== 'function') {
    throw new Error(`paymentController.${k} is not a function (got ${typeof ctrl[k]})`);
  }
});

// Routes
router.post('/payos/initiate', protect(['driver','staff','admin']), ctrl.initiateTopUpPayOS);
router.post('/payos/webhook', ctrl.payosWebhook);   // no auth
router.get('/payos/return', ctrl.payosReturn);
router.get('/payos/cancel', ctrl.payosCancel);

module.exports = router;
