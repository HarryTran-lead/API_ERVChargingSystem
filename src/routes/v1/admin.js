// routes/admin.js (ví dụ)
const express = require('express');
const router = express.Router();
router.post('/payos/confirm-webhook', async (req, res) => {
  const axios = require('axios');
  const url = req.body.webhookUrl; // gửi body: { "webhookUrl": "https://.../payos/webhook" }
  const { PAYOS_CLIENT_ID, PAYOS_API_KEY } = process.env;
  try {
    const { data } = await axios.post(
      'https://api-merchant.payos.vn/v2/confirm-webhook',
      { webhookUrl: url },
      { headers: { 'x-client-id': PAYOS_CLIENT_ID.trim(), 'x-api-key': PAYOS_API_KEY.trim() } }
    );
    res.json(data);
  } catch (e) {
    res.status(400).json(e.response?.data ?? { msg: e.message });
  }
});
