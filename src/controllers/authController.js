// src/controllers/authController.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const crypto = require('crypto');

const User = require('../models/User');
const Wallet = require('../models/Wallet');
const MembershipPlan = require('../models/MembershipPlan');
const UserMembership = require('../models/UserMembership');
const Station = require('../models/Station');

const ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);
const JWT_SECRET = process.env.JWT_SECRET;
const RESET_TOKEN_EXPIRES_MINUTES = Number(process.env.RESET_TOKEN_EXPIRES_MINUTES || 15);

const normalizeEmail = (email) =>
  typeof email === 'string' ? email.trim().toLowerCase() : '';

// 👉 HELPER: đảm bảo user luôn có membership (mặc định FREE nếu chưa có)
async function ensureUserMembership(userId) {
  let um = await UserMembership.findOne({ user_id: userId });
  if (um) return um;

  const free = await MembershipPlan.findOne({ code: 'FREE', status: 'ACTIVE' }).lean();
  um = await UserMembership.create({
    user_id: userId,
    plan_code: free?.code || 'FREE',
    plan_name: free?.name || 'Free',
    monthly_fee_vnd: free?.monthly_fee_vnd || 0,
    status: 'ACTIVE',
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
    let stationId = req.body?.stationId ?? req.body?.stationid;

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

    // Chuẩn hoá & kiểm tra stationId nếu truyền vào
    if (stationId != null) {
      stationId = String(stationId).trim();
      if (!stationId) stationId = undefined;
    }

    // staff thì bắt buộc phải có stationId
    if (role === 'staff' && !stationId) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'STATION_ID_REQUIRED' });
    }

    // Nếu có stationId thì validate ObjectId & tồn tại
    if (stationId) {
      if (!mongoose.Types.ObjectId.isValid(stationId)) {
        await session.abortTransaction();
        return res.status(400).json({ error: 'INVALID_STATION_ID' });
      }
      const station = await Station.findById(stationId).session(session).select('_id').lean();
      if (!station) {
        await session.abortTransaction();
        return res.status(404).json({ error: 'STATION_NOT_FOUND' });
      }
      stationId = station._id;
    }

    // Tạo user + wallet trong transaction
    const [user] = await User.create(
      [
        {
          name: name.trim(),
          email,
          phone,
          role, // undefined -> schema default 'driver'
          password_hash: passwordHash,
          stationId, // có thể undefined nếu không truyền hoặc không phải staff
        },
      ],
      { session }
    );

    await Wallet.create([{ user_id: user.id }], { session });

    // Khởi tạo membership FREE để nhất quán dữ liệu
    const free = await MembershipPlan.findOne({ code: 'FREE', status: 'ACTIVE' })
      .session(session)
      .lean();
    await UserMembership.create(
      [
        {
          user_id: user.id,
          plan_code: free?.code || 'FREE',
          plan_name: free?.name || 'Free',
          monthly_fee_vnd: free?.monthly_fee_vnd || 0,
          status: 'ACTIVE',
        },
      ],
      { session }
    );

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, {
      expiresIn: '7d',
    });

    await session.commitTransaction();
    return res.status(201).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        stationId: user.stationId ?? null,
      },
      membership: {
        plan_code: free?.code || 'FREE',
        plan_name: free?.name || 'Free',
        monthly_fee_vnd: free?.monthly_fee_vnd || 0,
        status: 'ACTIVE',
      },
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

    // đảm bảo có membership & trả về cho UI
    const um = await ensureUserMembership(user.id);
    const plan = await MembershipPlan.findOne({
      code: um.plan_code,
      status: 'ACTIVE',
    })
      .select('code name monthly_fee_vnd mods')
      .lean();

    return res.json({
      token,
      user: {
        id: user.id,
        role: user.role,
        name: user.name,
        email: user.email,
        stationId: user.stationId ?? null,
      },
      membership: {
        plan_code: um.plan_code,
        plan_name: um.plan_name,
        monthly_fee_vnd: um.monthly_fee_vnd,
        status: um.status,
        renew_at: um.renew_at,
        plan_public: plan || null,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: 'SERVER_ERROR', detail: err.message });
  }
};

exports.requestPasswordReset = async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!email) {
    return res.status(400).json({ error: 'EMAIL_REQUIRED' });
  }

  const user = await User.findOne({ email });
  if (user) {
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRES_MINUTES * 60 * 1000);

    user.password_reset_token = resetToken;
    user.password_reset_expires = expiresAt;
    await user.save();

    // Trong môi trường thực tế bạn nên gửi email/SMS, ở đây trả thẳng token cho mobile client dùng ngay
    return res.json({ message: 'RESET_TOKEN_ISSUED', token: resetToken, expiresAt });
  }

  // tránh lộ thông tin tồn tại của email
  return res.json({ message: 'RESET_TOKEN_ISSUED' });
};

exports.resetPassword = async (req, res) => {
  const { token, password } = req.body || {};

  if (!token || !password) {
    return res.status(400).json({ error: 'TOKEN_AND_PASSWORD_REQUIRED' });
  }

  const user = await User.findOne({
    password_reset_token: token,
    password_reset_expires: { $gt: new Date() },
  });

  if (!user) {
    return res.status(400).json({ error: 'INVALID_OR_EXPIRED_TOKEN' });
  }

  const passwordHash = await bcrypt.hash(String(password), ROUNDS);
  user.password_hash = passwordHash;
  user.password_reset_token = undefined;
  user.password_reset_expires = undefined;
  user.password_changed_at = new Date();
  await user.save();

  return res.json({ message: 'PASSWORD_RESET_SUCCESS' });
};

exports.changePassword = async (req, res) => {
  const userId = req.user?.id;
  const { currentPassword, newPassword } = req.body || {};

  if (!userId) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'PASSWORDS_REQUIRED' });
  }

  const user = await User.findOne({ id: userId });
  if (!user) {
    return res.status(404).json({ error: 'USER_NOT_FOUND' });
  }

  const match = await bcrypt.compare(String(currentPassword), user.password_hash);
  if (!match) {
    return res.status(400).json({ error: 'CURRENT_PASSWORD_INCORRECT' });
  }

  user.password_hash = await bcrypt.hash(String(newPassword), ROUNDS);
  user.password_changed_at = new Date();
  user.password_reset_token = undefined;
  user.password_reset_expires = undefined;
  await user.save();

  return res.json({ message: 'PASSWORD_CHANGED' });
};