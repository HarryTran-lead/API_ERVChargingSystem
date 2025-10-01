// src/utils/paymentSign.js
const crypto = require('crypto');

// Encode kiểu VNPay: URL-encode rồi thay ' ' -> '+'
function encodeVNPay(v) {
  return encodeURIComponent(String(v)).replace(/%20/g, '+');
}

// Sort keys (ASCII) rồi build query
function sortObj(obj) {
  const out = {};
  Object.keys(obj).sort().forEach(k => (out[k] = obj[k]));
  return out;
}

// Build chuỗi query theo chuẩn VNPay (dùng cho ký & URL)
function buildVnpQuery(params) {
  const sorted = sortObj(params);
  return Object.keys(sorted)
    .map(k => `${k}=${encodeVNPay(sorted[k])}`)
    .join('&');
}

function vnpHashFromParams(params, secret) {
  const signData = buildVnpQuery(params); // CHUỖI ĐÃ ENCODE + thay ' ' -> '+'
  return crypto.createHmac('sha512', secret).update(signData, 'utf-8').digest('hex');
}

function buildVnpUrl(baseUrl, params, secret) {
  const query = buildVnpQuery(params);
  const secure = vnpHashFromParams(params, secret);
  // VNPay hiện dùng 'SHA512' (không phải 'HmacSHA512')
  return `${baseUrl}?${query}&vnp_SecureHashType=SHA512&vnp_SecureHash=${secure}`;
}

module.exports = { encodeVNPay, sortObj, buildVnpQuery, vnpHashFromParams, buildVnpUrl };
