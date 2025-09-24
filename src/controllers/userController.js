const User = require('../models/User');
const Wallet = require('../models/Wallet');

// GET /api/v1/users
exports.getAllUsers = async (req, res) => {
  try {
    const users = await User.find({}, '-password_hash'); // exclude password
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};

// GET /api/v1/users/:id
exports.getUser = async (req, res) => {
  try {
    const user = await User.findOne({ id: req.params.id }, '-password_hash');
    if (!user) return res.status(404).json({ msg: 'User not found' });
    res.json(user);
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

    // Xóa wallet liên quan
    await Wallet.deleteOne({ user_id: user.id });
    await user.deleteOne();

    res.json({ msg: 'User deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};
