// src/middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');

function normalizeSecret(raw) {
  return String(raw || '').replace(/\r?\n/g, '').trim(); // tránh \n cuối dòng của .env
}

// Cho phép cấu hình thuật toán qua ENV, mặc định mở HS256 & HS512
function getAllowedAlgs() {
  const env = process.env.JWT_ALGS || 'HS256,HS512';
  return env.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Core auth handler dùng chung cho protect / optionalAuth
 * - roles: mảng role cho phép
 * - skipWhenNoToken:
 *    + false  => nếu không có token thì 401 (giống protect cũ)
 *    + true   => nếu không có token thì bỏ qua, next() luôn (dùng cho optionalAuth không cần role)
 */
function buildAuthMiddleware({ roles = [], skipWhenNoToken = false }) {
  const allow = Array.isArray(roles) ? roles : [roles].filter(Boolean);

  return async (req, res, next) => {
    const auth = req.headers.authorization || '';
    // chấp nhận chữ hoa/thường “Bearer”
    if (!/^bearer\s+/i.test(auth)) {
      if (skipWhenNoToken) return next();
      return res.status(401).json({ msg: 'No token provided' });
    }

    const token = auth.replace(/^bearer\s+/i, '').trim();
    if (!token) return res.status(401).json({ msg: 'No token provided' });

    const secret = normalizeSecret(process.env.JWT_SECRET);
    if (!secret) return res.status(500).json({ msg: 'Server auth misconfigured' });

    let payload;
    try {
      payload = jwt.verify(token, secret, {
        algorithms: getAllowedAlgs(), // bắt buộc đúng alg (HS256/HS512…)
        clockTolerance: 60,           // nới clock skew 60s cho dev
      });
    } catch (e) {
      const msg =
        e.name === 'TokenExpiredError' ? 'Token expired' :
        e.name === 'JsonWebTokenError' ? 'Invalid token' :
        'Invalid token';
      return res.status(401).json({ msg });
    }

    // BẮT BUỘC có claim id dạng string (UUID app bạn đang dùng)
    if (!payload || typeof payload.id !== 'string' || !payload.id) {
      return res.status(401).json({ msg: 'Token missing id claim' });
    }

    // Lấy user theo field "id" (không phải _id)
    const user = await User.findOne({ id: payload.id }).select('id role status stationId');
    if (!user) return res.status(401).json({ msg: 'User not found' });
    if (user.status !== 'ACTIVE') return res.status(403).json({ msg: 'User is not active' });

    // Kiểm tra role nếu được yêu cầu
    if (allow.length && !allow.includes(user.role)) {
      return res.status(403).json({ msg: 'Forbidden: insufficient role' });
    }

    // Gắn thông tin tối thiểu vào req
    req.user = {
      id: user.id,
      role: user.role,
      stationId: user.stationId ? user.stationId.toString() : undefined,
    };

    return next();
  };
}

// Giữ nguyên hành vi protect cũ: luôn yêu cầu token
exports.protect = (roles = []) => {
  return async (req, res, next) => {
    try {
      const handler = buildAuthMiddleware({ roles, skipWhenNoToken: false });
      return handler(req, res, next);
    } catch (err) {
      console.error('[protect] error:', err);
      return res.status(500).json({ msg: 'Auth error' });
    }
  };
};

/**
 * optionalAuth:
 * - optionalAuth()            => nếu không có token thì cho qua, nếu có token thì verify & gắn req.user
 * - optionalAuth(['ADMIN'])   => giống protect(['ADMIN']) (vẫn bắt buộc có token & đúng role)
 */
exports.optionalAuth = (roles = []) => {
  const skipWhenNoToken = Array.isArray(roles) ? roles.length === 0 : !roles;
  return async (req, res, next) => {
    try {
      const handler = buildAuthMiddleware({ roles, skipWhenNoToken });
      return handler(req, res, next);
    } catch (err) {
      console.error('[optionalAuth] error:', err);
      return res.status(500).json({ msg: 'Auth error' });
    }
  };
};
