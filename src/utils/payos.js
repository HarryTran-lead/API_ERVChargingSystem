// src/utils/payos.js
const axios = require('axios');
const crypto = require('crypto');

const BASE = 'https://api-merchant.payos.vn/v2';

const {
  PAYOS_CLIENT_ID,
  PAYOS_API_KEY,
  PAYOS_CHECKSUM_KEY,
} = process.env;

function hmac(jsonString) {
  return crypto
    .createHmac('sha256', (PAYOS_CHECKSUM_KEY || '').trim())
    .update(jsonString)
    .digest('hex');
}

// ===== API wrappers =====

// Tạo link thanh toán
async function createPaymentLink({ orderCode, amount, description, returnUrl, cancelUrl }) {
  // payload cơ bản
  const base = { orderCode, amount, description, returnUrl, cancelUrl };

  // PayOS yêu cầu signature NẰM TRONG BODY
  const rawBase = JSON.stringify(base);
  const signature = hmac(rawBase);
  const body = { ...base, signature };

  const { data } = await axios.post(
    `${BASE}/payment-requests`,
    JSON.stringify(body), // gửi raw để giữ thứ tự key
    {
      headers: {
        'x-client-id': (PAYOS_CLIENT_ID || '').trim(),
        'x-api-key': (PAYOS_API_KEY || '').trim(),
        'content-type': 'application/json',
      },
      transformRequest: [(d) => d], // đừng re-stringify
    }
  );

  // Trả đúng shape ở controller mẫu đang dùng
  return data?.data || data;
}

// Lấy thông tin link thanh toán
async function getPaymentLinkInfomation(orderCode) {
  const { data } = await axios.get(
    `${BASE}/payment-requests/${orderCode}`,
    {
      headers: {
        'x-client-id': (PAYOS_CLIENT_ID || '').trim(),
        'x-api-key': (PAYOS_API_KEY || '').trim(),
      },
    }
  );
  return data?.data || data;
}

// Huỷ link thanh toán
async function cancelPaymentLink(orderCode, cancellationReason = 'user_cancel') {
  const { data } = await axios.put(
    `${BASE}/payment-requests/${orderCode}/cancel`,
    { cancellationReason },
    {
      headers: {
        'x-client-id': (PAYOS_CLIENT_ID || '').trim(),
        'x-api-key': (PAYOS_API_KEY || '').trim(),
        'content-type': 'application/json',
      },
    }
  );
  return data?.data || data;
}

// Xác nhận webhook URL (tùy dùng)
async function confirmWebhook(webhookUrl) {
  const body = { webhookUrl };
  const raw = JSON.stringify(body);
  const signature = hmac(raw);
  const { data } = await axios.post(
    `${BASE}/webhooks`,
    raw,
    {
      headers: {
        'x-client-id': (PAYOS_CLIENT_ID || '').trim(),
        'x-api-key': (PAYOS_API_KEY || '').trim(),
        'x-signature': signature,
        'content-type': 'application/json',
      },
      transformRequest: [(d) => d],
    }
  );
  return data?.data || data;
}

// Verify webhook (body JSON, ký trên RAW body)
function verifyPaymentWebhookData(body, rawBody, sigHeader) {
  // PayOS gửi chữ ký ở header: x-payos-signature (hoặc x-signature)
  const expected = hmac(rawBody);
  if (String(sigHeader || '').trim() !== expected) {
    const err = new Error('INVALID_WEBHOOK_SIGNATURE');
    err.code = 'INVALID_SIGNATURE';
    throw err;
  }
  return body; // body.data chứa orderCode, amount, status...
}

module.exports = {
  createPaymentLink,
  getPaymentLinkInfomation,
  cancelPaymentLink,
  confirmWebhook,
  verifyPaymentWebhookData,
};
