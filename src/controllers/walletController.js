// src/controllers/walletController.js
const Wallet = require('../models/Wallet');
const WalletTx = require('../models/WalletTransaction');

exports.getMyWallet = async (req, res) => {
  const wallet = await Wallet.findOne({ user_id: req.user.id });
  if (!wallet) return res.status(404).json({ msg: 'Wallet not found' });
  res.json(wallet);
};

// GET /api/v1/wallet/transactions?type=TOPUP&from=2025-01-01&to=2025-12-31&page=1&limit=20
exports.listMyTransactions = async (req, res) => {
  const userId = req.user.id;

  const {
    type,           // TOPUP | DEBIT | REFUND (tùy schema của bạn)
    from,           // ISO date string
    to,             // ISO date string
    page = 1,
    limit = 20
  } = req.query;

  const q = { user_id: userId };
  if (type) q.type = String(type).toUpperCase();

  // lọc theo thời gian tạo (timestamps: true => createdAt)
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
    WalletTx.countDocuments(q)
  ]);

  res.json({
    page: p,
    limit: sz,
    total,
    pages: Math.ceil(total / sz),
    items
  });
};

