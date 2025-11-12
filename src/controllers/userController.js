// src/controllers/userController.js
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Vehicle = require('../models/Vehicle');

// GET /api/v1/users
exports.getAllUsers = async (req, res) => {
  try {
    // Lấy users, loại bỏ trường password_hash, và trả về plain object
    const users = await User.find({}, '-password_hash').lean();

    // Gom userIds để truy vấn vehicles 1 lần
    const userIds = users.map((u) => u.id);
    const vehicles = await Vehicle.find(
      { user_id: { $in: userIds }, deleted_at: null },
      '-_id -license_plate_norm'
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
    const user = await User.findOne({ id: req.params.id }, '-password_hash').lean();
    if (!user) return res.status(404).json({ msg: 'User not found' });

    const vehicles = await Vehicle.find(
      { user_id: user.id, deleted_at: null },
      '-_id -license_plate_norm'
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
    const user = await User.findOne({ id: req.params.id });
    if (!user) return res.status(404).json({ msg: 'User not found' });

    if (name) user.name = name;
    if (phone) user.phone = phone;
    if (role) user.role = role;
    if (status) user.status = status;

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
