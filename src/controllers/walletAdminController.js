// src/controllers/walletAdminController.js
const Wallet   = require('../models/Wallet');
const WalletTx = require('../models/WalletTransaction');

// [ĐÃ CÓ] admin xem ví + giao dịch của 1 user
exports.getUserWalletAndTransactions = async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'FORBIDDEN_ADMIN_ONLY' });
    }

    const {
      userId,
      type,
      from,
      to,
      page = 1,
      limit = 20,
    } = req.query;

    if (!userId || !String(userId).trim()) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const wallet = await Wallet.findOne({ user_id: userId })
      .lean()
      .select('id user_id balance createdAt updatedAt');

    if (!wallet) {
      return res.status(404).json({ error: 'WALLET_NOT_FOUND_FOR_USER' });
    }

    const q = { user_id: userId };

    if (type) {
      q.type = String(type).toUpperCase(); // TOPUP | DEBIT | REFUND
    }

    if (from || to) {
      q.createdAt = {};
      if (from) q.createdAt.$gte = new Date(from);
      if (to)   q.createdAt.$lte = new Date(to);
    }

    const p  = Math.max(1, Number(page));
    const sz = Math.max(1, Math.min(100, Number(limit)));

    const [items, total] = await Promise.all([
      WalletTx.find(q)
        .sort({ createdAt: -1 })
        .skip((p - 1) * sz)
        .limit(sz)
        .lean(),
      WalletTx.countDocuments(q),
    ]);

    return res.json({
      userId,
      wallet: {
        wallet_id: wallet.id,
        balance: wallet.balance,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      },
      transactions: {
        page: p,
        limit: sz,
        total,
        pages: Math.ceil(total / sz),
        items: items.map(tx => ({
          id: tx.id,
          user_id: tx.user_id,
          wallet_id: tx.wallet_id,
          type: tx.type,
          category: tx.category,
          amount: tx.amount,
          method: tx.method,
          status: tx.status,
          resulting_balance: tx.resulting_balance,
          idempotency_key: tx.idempotency_key,
          meta: tx.meta,
          createdAt: tx.createdAt,
        })),
      },
    });
  } catch (err) {
    console.error('admin wallet error:', err);
    return res.status(500).json({
      error: 'SERVER_ERROR',
      detail: err.message,
    });
  }
};

// ✅ MỚI: admin xem tất cả giao dịch của mọi user
// GET /api/v1/admin/wallet/transactions?type=TOPUP&userId=...&from=2025-01-01&to=2025-12-31&page=1&limit=50
exports.listAllTransactionsAdmin = async (req, res) => {
  try {
    // bảo vệ role
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'FORBIDDEN_ADMIN_ONLY' });
    }

    const {
      userId,        // optional: lọc theo 1 user cụ thể
      type,          // optional: TOPUP | DEBIT | REFUND
      from,          // optional ISO date
      to,            // optional ISO date
      page = 1,
      limit = 50,    // default lớn hơn một chút
    } = req.query;

    // Build query động
    const q = {};

    if (userId && String(userId).trim()) {
      q.user_id = String(userId).trim();
    }

    if (type) {
      q.type = String(type).toUpperCase();
    }

    if (from || to) {
      q.createdAt = {};
      if (from) q.createdAt.$gte = new Date(from);
      if (to)   q.createdAt.$lte = new Date(to);
    }

    // phân trang
    const p  = Math.max(1, Number(page));
    const sz = Math.max(1, Math.min(200, Number(limit))); // admin có thể cần nhìn nhiều hơn -> max 200

    // query DB
    const [items, total] = await Promise.all([
      WalletTx.find(q)
        .sort({ createdAt: -1 })        // mới nhất trước
        .skip((p - 1) * sz)
        .limit(sz)
        .lean(),
      WalletTx.countDocuments(q),
    ]);

    return res.json({
      page: p,
      limit: sz,
      total,
      pages: Math.ceil(total / sz),
      items: items.map(tx => ({
        id: tx.id,
        user_id: tx.user_id,
        wallet_id: tx.wallet_id,
        type: tx.type,                 // TOPUP | DEBIT | REFUND
        category: tx.category,         // SUBSCRIPTION | CHARGE | ...
        amount: tx.amount,
        method: tx.method,             // wallet | payos | ...
        status: tx.status,             // SUCCEEDED / PENDING / FAILED
        resulting_balance: tx.resulting_balance,
        idempotency_key: tx.idempotency_key,
        meta: tx.meta,
        createdAt: tx.createdAt,
      })),
    });
  } catch (err) {
    console.error('admin listAllTransactions error:', err);
    return res.status(500).json({
      error: 'SERVER_ERROR',
      detail: err.message,
    });
  }
};
