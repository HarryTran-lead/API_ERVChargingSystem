// src/controllers/paymentController.js
const Wallet = require('../models/Wallet');
const mongoose = require('mongoose');

exports.topUp = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { amount, method } = req.body;
    if (!amount || amount <= 0) throw new Error('Invalid amount');

    const wallet = await Wallet.findOne({ user_id: req.user.id }).session(session);
    if (!wallet) throw new Error('Wallet not found');

    // Update balance (optimistic locking)
    wallet.balance += amount;
    wallet.version = wallet.version + 1;
    await wallet.save({ session });

    await session.commitTransaction();
    session.endSession();

    res.json({ msg: 'Top-up success', balance: wallet.balance });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    res.status(400).json({ msg: err.message });
  }
};
