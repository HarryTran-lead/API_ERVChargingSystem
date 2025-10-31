const User = require('../models/User');

// GET /api/v1/profile
exports.getProfile = async (req, res) => {
  try {
    // req.user is attached by authMiddleware.protect
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ msg: 'Unauthorized' });

    const user = await User.findOne({ id: userId }).select('-password_hash -__v');
    if (!user) return res.status(404).json({ msg: 'User not found' });

    // Return a minimal profile object
    return res.json({ success: true, user });
  } catch (err) {
    console.error('[profileController.getProfile] ', err);
    return res.status(500).json({ msg: 'Server error' });
  }
};

// PATCH /api/v1/profile
exports.updateProfile = async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ msg: 'Unauthorized' });

    const { name, phone } = req.body;

    const user = await User.findOne({ id: userId });
    if (!user) return res.status(404).json({ msg: 'User not found' });

    if (typeof name === 'string' && name.trim().length) user.name = name.trim();
    if (typeof phone === 'string') user.phone = phone.trim() || undefined;

    await user.save();

    const out = user.toObject();
    delete out.password_hash;
    delete out.__v;

    return res.json({ success: true, user: out });
  } catch (err) {
    console.error('[profileController.updateProfile] ', err);
    return res.status(500).json({ msg: 'Server error' });
  }
};

// PATCH /api/v1/profile
exports.updateProfile = async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ msg: 'Unauthorized' });

    const { name, phone } = req.body;

    const user = await User.findOne({ id: userId });
    if (!user) return res.status(404).json({ msg: 'User not found' });

    if (typeof name === 'string' && name.trim().length) user.name = name.trim();
    if (typeof phone === 'string') user.phone = phone.trim() || undefined;

    await user.save();

    const out = user.toObject();
    delete out.password_hash;
    delete out.__v;

    return res.json({ success: true, user: out });
  } catch (err) {
    console.error('[profileController.updateProfile] ', err);
    return res.status(500).json({ msg: 'Server error' });
  }
};
