// src/controllers/authController.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const Wallet = require('../models/Wallet');

// 👉 THÊM 2 IMPORT NÀY
const MembershipPlan = require('../models/MembershipPlan');
const UserMembership  = require('../models/UserMembership');

const ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);
const JWT_SECRET = process.env.JWT_SECRET;

const normalizeEmail = (email) =>
  typeof email === 'string' ? email.trim().toLowerCase() : '';

// 👉 HELPER: đảm bảo user luôn có membership (mặc định FREE nếu chưa có)
async function ensureUserMembership(userId) {
  let um = await UserMembership.findOne({ user_id: userId });
  if (um) return um;

  // Lấy plan FREE đang ACTIVE; nếu không có thì fallback
  const free = await MembershipPlan.findOne({ code: 'FREE', status: 'ACTIVE' }).lean();
  um = await UserMembership.create({
    user_id: userId,
    plan_code: free?.code || 'FREE',
    plan_name: free?.name || 'Free',
    monthly_fee_vnd: free?.monthly_fee_vnd || 0,
    status: 'ACTIVE'
  });
  return um;
}

exports.signup = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { name, phone } = req.body || {};
    const email = normalizeEmail(req.body?.email);
    let password = req.body?.password;
    let role = req.body?.role;

    // Validate cơ bản
    if (!name || typeof name !== 'string') {
      await session.abortTransaction();
      return res.status(400).json({ error: 'NAME_REQUIRED' });
    }
    if (!email) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'EMAIL_REQUIRED' });
    }
    if (password == null) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'PASSWORD_REQUIRED' });
    }
    password = String(password);
    if (!password.trim()) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'PASSWORD_REQUIRED' });
    }

    // Check tồn tại
    const exists = await User.findOne({ email }).session(session);
    if (exists) {
      await session.abortTransaction();
      return res.status(409).json({ error: 'EMAIL_EXISTS' });
    }

    // Hash
    const passwordHash = await bcrypt.hash(password, ROUNDS);

    // Role: mặc định theo schema nếu không hợp lệ
    const validRoles = new Set(['driver', 'staff', 'admin']);
    if (!validRoles.has(role)) role = undefined;

    // Tạo user + wallet trong transaction
    const [user] = await User.create(
      [
        {
          name: name.trim(),
          email,
          phone,
          role, // undefined -> schema default 'driver'
          password_hash: passwordHash,
        },
      ],
      { session }
    );

    await Wallet.create([{ user_id: user.id }], { session });

    // (tuỳ chọn) Khởi tạo membership FREE luôn khi signup để nhất quán dữ liệu
    const free = await MembershipPlan.findOne({ code: 'FREE', status: 'ACTIVE' })
      .session(session)
      .lean();
    await UserMembership.create([{
      user_id: user.id,
      plan_code: free?.code || 'FREE',
      plan_name: free?.name || 'Free',
      monthly_fee_vnd: free?.monthly_fee_vnd || 0,
      status: 'ACTIVE'
    }], { session });

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, {
      expiresIn: '7d',
    });

    await session.commitTransaction();
    return res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      // (tuỳ chọn) trả luôn membership để UI hiển thị ngay sau đăng ký
      membership: {
        plan_code: free?.code || 'FREE',
        plan_name: free?.name || 'Free',
        monthly_fee_vnd: free?.monthly_fee_vnd || 0,
        status: 'ACTIVE'
      }
    });
  } catch (err) {
    await session.abortTransaction();
    if (err?.code === 11000) {
      return res.status(409).json({ error: 'DUPLICATE', detail: err.keyValue });
    }
    return res.status(500).json({ error: 'SERVER_ERROR', detail: err.message });
  } finally {
    session.endSession();
  }
};

exports.login = async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? '');

    if (!email || !password) {
      return res.status(400).json({ error: 'INVALID_CREDENTIALS' });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'INVALID_CREDENTIALS' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(400).json({ error: 'INVALID_CREDENTIALS' });

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, {
      expiresIn: '7d',
    });

    // 👉 đảm bảo có membership & trả về cho UI
    const um = await ensureUserMembership(user.id);
    const plan = await MembershipPlan.findOne({ code: um.plan_code, status: 'ACTIVE' })
      .select('code name monthly_fee_vnd mods')
      .lean();

    return res.json({
      token,
      user: { id: user.id, role: user.role, name: user.name, email: user.email },
      membership: {
        plan_code: um.plan_code,
        plan_name: um.plan_name,
        monthly_fee_vnd: um.monthly_fee_vnd,
        status: um.status,
        renew_at: um.renew_at,
        plan_public: plan || null
      }
    });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', detail: err.message });
  }
};
