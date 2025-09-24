// src/middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = (roles = []) => {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ msg: 'No token provided' });
      }

      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET); // { id, role }

      // Lấy thông tin user từ DB
      const user = await User.findOne({ id: decoded.id });
      if (!user) return res.status(401).json({ msg: 'User not found' });

      // Kiểm tra status
      if (user.status !== 'ACTIVE') {
        return res.status(403).json({ msg: 'User is not active' });
      }

      // Kiểm tra roles nếu truyền vào
      if (roles.length && !roles.includes(user.role)) {
        return res.status(403).json({ msg: 'Forbidden: insufficient role' });
      }

      req.user = user; // lưu thông tin user đầy đủ vào req
      next();
    } catch (err) {
      console.error('Auth error:', err.message);
      return res.status(401).json({ msg: 'Invalid or expired token' });
    }
  };
};

// Export dưới dạng object để có thể destructure
module.exports = { protect };
