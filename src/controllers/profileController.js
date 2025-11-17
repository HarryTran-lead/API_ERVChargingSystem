// src/controllers/profileController.js
// Delegates profile-related requests to userController to reuse logic
const userController = require('./userController');

exports.getProfile = (req, res, next) => {
  try {
    req.params = req.params || {};
    if (req.user && req.user.id) req.params.id = req.user.id;
    return userController.getUser(req, res, next);
  } catch (err) {
    console.error('[profileController.getProfile] ', err);
    return res.status(500).json({ msg: 'Server error' });
  }
};

exports.updateProfile = (req, res, next) => {
  try {
    req.params = req.params || {};
    if (req.user && req.user.id) req.params.id = req.user.id;
    return userController.updateUser(req, res, next);
  } catch (err) {
    console.error('[profileController.updateProfile] ', err);
    return res.status(500).json({ msg: 'Server error' });
  }
};
