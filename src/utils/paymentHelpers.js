// src/utils/paymentHelpers.js
function genId(prefix = 'ORD') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : (fwd || '').split(',')[0];
  return (first || req.connection?.remoteAddress || req.socket?.remoteAddress || '').trim();
}

module.exports = { genId, getClientIp };
