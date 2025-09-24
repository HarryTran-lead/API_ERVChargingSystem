// src/controllers/walletController.js
const Wallet = require('../models/Wallet');

exports.getMyWallet = async (req, res) => {
  const wallet = await Wallet.findOne({ user_id: req.user.id });
  if (!wallet) return res.status(404).json({ msg: 'Wallet not found' });
  res.json(wallet);
};
