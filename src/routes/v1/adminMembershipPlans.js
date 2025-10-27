// src/routes/v1/adminMembershipPlans.js
const express = require('express');
const router = express.Router();

const ctrl = require('../../controllers/membershipPlanAdminController');
const { protect } = require('../../middlewares/authMiddleware');

// chỉ cho ADMIN
router.use(protect(['admin']));

// Base: /api/v1/admin/membership-plans
router.post('/',              ctrl.create);       // tạo gói
router.get('/',               ctrl.list);         // list gói
router.get('/:id',            ctrl.getOne);       // xem 1 gói
router.patch('/:id',          ctrl.update);       // sửa (trừ code)
router.patch('/:id/activate',   ctrl.activate);   // bật
router.patch('/:id/deactivate', ctrl.deactivate); // tắt
router.delete('/:id',         ctrl.remove);       // xoá (khuyên dùng deactivate hơn)

module.exports = router;
