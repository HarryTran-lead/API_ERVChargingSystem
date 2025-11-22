// src/controllers/userController.js
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Vehicle = require('../models/Vehicle');
const MembershipPlan = require('../models/MembershipPlan');
const UserMembership = require('../models/UserMembership');
const Station = require('../models/Station');
const { ROLES } = require('../constants/enums');

const ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);
const normalizeEmail = (email) =>
  (typeof email === 'string' ? email.trim().toLowerCase() : '');

/**
 * POST /api/v1/users
 * Tạo user mới (admin)
 * - Tạo user
 * - Tạo Wallet
 * - Gán Membership FREE
 */
exports.createUser = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { name, phone } = req.body || {};
    const email = normalizeEmail(req.body?.email);
    let password = req.body?.password;
    let role = req.body?.role;
    let stationId = req.body?.stationId ?? req.body?.stationid;

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

    const exists = await User.findOne({ email }).session(session);
    if (exists) {
      await session.abortTransaction();
      return res.status(409).json({ error: 'EMAIL_EXISTS' });
    }

    const passwordHash = await bcrypt.hash(password, ROUNDS);

    // chỉ chấp nhận 3 role này, còn lại coi như undefined (driver mặc định)
    const validRoles = new Set(['driver', 'staff', 'admin']);
    if (!validRoles.has(role)) role = undefined;

    if (stationId != null) {
      stationId = String(stationId).trim();
      if (!stationId) stationId = undefined;
    }

    if (role === 'staff' && !stationId) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'STATION_ID_REQUIRED' });
    }

    if (stationId) {
      if (!mongoose.Types.ObjectId.isValid(stationId)) {
        await session.abortTransaction();
        return res.status(400).json({ error: 'INVALID_STATION_ID' });
      }

      const station = await Station.findById(stationId)
        .session(session)
        .select('_id')
        .lean();
      if (!station) {
        await session.abortTransaction();
        return res.status(404).json({ error: 'STATION_NOT_FOUND' });
      }

      stationId = station._id;
    }

    const [user] = await User.create(
      [
        {
          name: name.trim(),
          email,
          phone,
          role,
          password_hash: passwordHash,
          stationId,
        },
      ],
      { session },
    );

    // Tạo wallet cho user
    await Wallet.create([{ user_id: user.id }], { session });

    // Gán membership FREE
    const free = await MembershipPlan.findOne({
      code: 'FREE',
      status: 'ACTIVE',
    })
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
      { session },
    );

    await session.commitTransaction();

    return res.status(201).json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        stationId: user.stationId ?? null,
      },
    });
  } catch (err) {
    await session.abortTransaction();

    if (err?.code === 11000) {
      return res.status(409).json({ error: 'DUPLICATE', detail: err.keyValue });
    }

    return res
      .status(500)
      .json({ error: 'SERVER_ERROR', detail: err.message });
  } finally {
    session.endSession();
  }
};

// GET /api/v1/users
exports.getAllUsers = async (req, res) => {
  try {
    // Lấy users, loại bỏ trường password_hash, và trả về plain object
    const users = await User.find({}, '-password_hash').lean();

    // Gom userIds để truy vấn vehicles 1 lần
    const userIds = users.map((u) => u.id);
    const vehicles = await Vehicle.find(
      { user_id: { $in: userIds }, deleted_at: null },
      '-_id -license_plate_norm',
    ).lean();

    // Nhóm vehicles theo user_id
    const vehiclesByUser = vehicles.reduce((acc, v) => {
      if (!acc[v.user_id]) acc[v.user_id] = [];
      acc[v.user_id].push(v);
      return acc;
    }, {});

    // Gắn vehicles vào từng user
    const usersWithVehicles = users.map((u) => ({
      ...u,
      vehicles: vehiclesByUser[u.id] || [],
    }));

    res.json(usersWithVehicles);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};

// GET /api/v1/users/:id
exports.getUser = async (req, res) => {
  try {
    const user = await User.findOne(
      { id: req.params.id },
      '-password_hash',
    ).lean();
    if (!user) return res.status(404).json({ msg: 'User not found' });

    const vehicles = await Vehicle.find(
      { user_id: user.id, deleted_at: null },
      '-_id -license_plate_norm',
    ).lean();

    res.json({
      ...user,
      vehicles,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};

// PUT /api/v1/users/:id
exports.updateUser = async (req, res) => {
  try {
    const { name, phone, role, status } = req.body;
    let stationId = req.body?.stationId ?? req.body?.stationid;

    const user = await User.findOne({ id: req.params.id });
    if (!user) return res.status(404).json({ msg: 'User not found' });

    let normalizedStationId;
    if (stationId !== undefined) {
      stationId = stationId === null ? '' : String(stationId).trim();

      if (stationId) {
        if (!mongoose.Types.ObjectId.isValid(stationId)) {
          return res.status(400).json({ error: 'INVALID_STATION_ID' });
        }

        const station = await Station.findById(stationId).select('_id');
        if (!station) {
          return res.status(404).json({ error: 'STATION_NOT_FOUND' });
        }

        normalizedStationId = station._id;
      } else {
        normalizedStationId = null;
      }
    }

    if (name) user.name = name;
    if (phone) user.phone = phone;
    if (role) user.role = role;
    if (status) user.status = status;

    const effectiveRole = user.role;
    if (effectiveRole === ROLES.STAFF) {
      const targetStationId = normalizedStationId ?? user.stationId;
      if (!targetStationId) {
        return res.status(400).json({ error: 'STATION_ID_REQUIRED' });
      }

      user.stationId = targetStationId;
    } else if (stationId !== undefined) {
      // cho phép clear / đổi station cho các role khác
      user.stationId = normalizedStationId;
    }

    await user.save();
    res.json({ msg: 'User updated', user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};

// DELETE /api/v1/users/:id
exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findOne({ id: req.params.id });
    if (!user) return res.status(404).json({ msg: 'User not found' });

    // Xóa wallet liên quan (nếu có)
    await Wallet.deleteOne({ user_id: user.id });
    await user.deleteOne();

    res.json({ msg: 'User deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};
