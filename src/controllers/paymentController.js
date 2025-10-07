// src/controllers/paymentController.js
const axios = require('axios');
const crypto = require('crypto');

const Wallet = require('../models/Wallet');
const WalletTx = require('../models/WalletTransaction');
const PaymentSession = require('../models/PaymentSession');

/* =========================
 * Helpers
 * ========================= */

// Tạo chuỗi ký: key=val&key=val..., sort key alpha
function toSignString(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      let val = v;
      if (val === null || val === undefined) val = '';
      else if (typeof val === 'object') val = JSON.stringify(val);
      return [k, String(val)];
    })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** Cộng ví idempotent */
async function creditWalletIdempotent({ user_id, amount, idempotency_key, method = 'payos', meta = {} }) {
  const session = await Wallet.startSession();
  let balance = 0;
  try {
    await session.withTransaction(async () => {
      const w = await Wallet.findOne({ user_id }).session(session);
      if (!w) throw new Error('Wallet not found');

      const existed = await WalletTx.findOne({ user_id, idempotency_key }).session(session);
      if (existed && existed.status === 'SUCCEEDED') { balance = w.balance; return; }

      const [tx] = await WalletTx.create([{
        wallet_id: w.id, user_id, type: 'TOPUP', amount, method, idempotency_key, status: 'PENDING', meta
      }], { session });

      const updated = await Wallet.findOneAndUpdate(
        { user_id }, { $inc: { balance: amount } }, { new: true, session }
      );
      balance = updated.balance;

      await WalletTx.updateOne(
        { id: tx.id },
        { $set: { status: 'SUCCEEDED', resulting_balance: balance } },
        { session }
      );
    });
  } finally { session.endSession(); }
  return { balance };
}

/* =========================
 * PayOS — INITIATE
 * ========================= */
async function initiateTopUpPayOS(req, res) {
  try {
    const {
      PAYOS_CLIENT_ID, PAYOS_API_KEY, PAYOS_CHECKSUM_KEY,
      PAYOS_RETURN_URL, PAYOS_CANCEL_URL
    } = process.env;

    // Kiểm tra ENV (tránh gửi thiếu thông tin)
    const missing = [];
    if (!PAYOS_CLIENT_ID) missing.push('PAYOS_CLIENT_ID');
    if (!PAYOS_API_KEY) missing.push('PAYOS_API_KEY');
    if (!PAYOS_CHECKSUM_KEY) missing.push('PAYOS_CHECKSUM_KEY');
    if (!PAYOS_RETURN_URL) missing.push('PAYOS_RETURN_URL');
    if (!PAYOS_CANCEL_URL) missing.push('PAYOS_CANCEL_URL');
    if (missing.length) return res.status(400).json({ msg: 'Thiếu ENV PayOS', missing });

    // Input
    const amount = Number(req.body.amount);
    if (!Number.isInteger(amount) || amount < 1000) {
      return res.status(400).json({ msg: 'Invalid amount (>= 1000)' });
    }

    // orderCode: 6 chữ số (đúng sample PayOS), kiểu number
    const orderCode = Number(String(Date.now()).slice(-6));

    // LƯU Ý: 2 URL này phải nằm trong whitelist trên Dashboard PayOS (đúng scheme/host/port)
    const payload = {
      orderCode,            // number
      amount,               // number
      description: 'Topup', // string
      returnUrl: PAYOS_RETURN_URL,
      cancelUrl: PAYOS_CANCEL_URL
    };

    // Ký HMAC SHA256 trên chuỗi key=val&... (đã sort) — signature đặt TRONG BODY
    const signString = toSignString(payload);
    const signature = crypto
      .createHmac('sha256', (PAYOS_CHECKSUM_KEY || '').trim())
      .update(signString)
      .digest('hex');

    const body = { ...payload, signature };

    console.log('[PayOS/init] signString =', signString);
    console.log('[PayOS/init] signature  =', signature);
    console.log('[PayOS/init] headers idLen=%d keyLen=%d',
      (PAYOS_CLIENT_ID || '').trim().length, (PAYOS_API_KEY || '').trim().length);

    // Gọi API (signature trong body; header chỉ cần client-id và api-key)
    const { data } = await axios.post(
      'https://api-merchant.payos.vn/v2/payment-requests',
      body,
      {
        headers: {
          'x-client-id': (PAYOS_CLIENT_ID || '').trim(),
          'x-api-key': (PAYOS_API_KEY || '').trim(),
          'content-type': 'application/json'
        }
      }
    );

    // Lưu phiên sau khi PayOS nhận OK
    const w = await Wallet.findOne({ user_id: req.user.id });
    await PaymentSession.create({
      kind: 'TOPUP',
      user_id: req.user.id,
      wallet_id: w?.id,
      provider: 'payos',
      provider_order_id: String(orderCode),
      amount,
      method: 'payos',
      status: 'PENDING'
    });

    const checkoutUrl = data?.data?.checkoutUrl || data?.checkoutUrl;
    return res.json({ provider: 'payos', orderCode, checkoutUrl, raw: data });
  } catch (e) {
    console.error('[PayOS/init] ERROR:', e.response?.data || e.message);
    return res.status(400).json(e.response?.data ?? { msg: e.message });
  }
}

/* =========================
 * PayOS — WEBHOOK
 * ========================= */
async function payosWebhook(req, res) {
  try {
    // Phải có middleware raw trước route này:
    // app.use('/api/v1/payments/payos/webhook', express.raw({ type: 'application/json' }));
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : (req.body || '');
    const sigHeader = String(req.headers['x-payos-signature'] || req.headers['x-signature'] || '');
    const expected  = crypto.createHmac('sha256', (process.env.PAYOS_CHECKSUM_KEY || '').trim())
                            .update(rawBody).digest('hex');

    if (sigHeader !== expected) return res.status(400).send('INVALID');

    const body = JSON.parse(rawBody);
    if (String(body.code) === '00' && body?.data?.status === 'PAID') {
      const orderCode = String(body.data.orderCode);
      const ps = await PaymentSession.findOne({ provider: 'payos', provider_order_id: orderCode });
      if (ps) {
        await creditWalletIdempotent({
          user_id: ps.user_id,

          amount: ps.amount,
          idempotency_key: `payos:${orderCode}`,
          method: 'payos',
          meta: body.data
        });
        await PaymentSession.updateOne({ _id: ps._id }, { $set: { status: 'SUCCEEDED' } });
      }
    }
    return res.status(200).send('OK');
  } catch (e) {
    console.error('[PayOS webhook] error:', e);
    return res.status(200).send('OK'); // PayOS chỉ cần 200 để ngừng retry
  }
}
// Fallback: cộng ví ở return nếu webhook chưa kịp đến
exports.payosReturn = async (req, res) => {
  try {
    const { orderCode } = req.query;
    const oc = String(orderCode || '');

    // 1) Tìm PaymentSession
    const ps = await PaymentSession.findOne({ provider: 'payos', provider_order_id: oc });
    if (!ps) return res.json({ ok: false, reason: 'PaymentSession not found', query: req.query });

    // 2) Nếu chưa SUCCEEDED, hỏi PayOS để xác thực
    if (ps.status !== 'SUCCEEDED') {
      const BASE = 'https://api-merchant.payos.vn/v2';
      const { data } = await axios.get(`${BASE}/payment-requests/${oc}`, {
        headers: {
          'x-client-id': (process.env.PAYOS_CLIENT_ID || '').trim(),
          'x-api-key': (process.env.PAYOS_API_KEY || '').trim(),
        }
      });

      const status = data?.data?.status;
      if (status === 'PAID') {
        // 3) Cộng ví idempotent
        await creditWalletIdempotent({
          user_id: ps.user_id,
          amount: ps.amount,
          idempotency_key: `payos:${oc}`,
          method: 'payos',
          meta: { source: 'return_fallback' }
        });
        await PaymentSession.updateOne({ _id: ps._id }, { $set: { status: 'SUCCEEDED' } });
      }
    }

    // Lấy lại số dư ví mới và luôn redirect về frontend
    const amount = ps.amount;
    const w = await Wallet.findOne({ user_id: ps.user_id });
    const balance = w ? w.balance : 0;
    return res.redirect(
      `http://localhost:5173/topup/success?orderCode=${orderCode}&amount=${amount}&balance=${balance}&status=PAID`
    );
  } catch (e) {
    console.error('[payosReturn] error:', e.response?.data || e.message);
    return res.status(500).json({ ok: false, msg: e.message, query: req.query });
  }
};

/* =========================
 * Return/Cancel (optional)
 * ========================= */
async function payosReturn(req, res) { res.json({ provider: 'payos', query: req.query }); }
async function payosCancel(req, res) { res.json({ provider: 'payos', query: req.query }); }

module.exports = {
  initiateTopUpPayOS,
  payosWebhook,
  payosReturn,
  payosCancel,
};
