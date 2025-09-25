// controllers/paymentController.js
const mongoose = require('mongoose')
const Wallet = require('../models/Wallet')
const WalletTx = require('../models/WalletTransaction')

exports.topUp = async (req, res) => {
  const session = await mongoose.startSession()
  try {
    const { amount, method, idempotency_key } = req.body
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('Invalid amount')
    if (!idempotency_key) throw new Error('Missing idempotency_key')

    let updated

    await session.withTransaction(async () => {
      const wallet = await Wallet.findOne({ user_id: req.user.id }).session(session)
      if (!wallet) throw new Error('Wallet not found')

      // 1) Check idempotency: nếu đã có giao dịch với key này thì trả về ngay
      const existed = await WalletTx.findOne({ idempotency_key }).session(session)
      if (existed) {
        // Đảm bảo trả lại số dư hiện tại
        const current = await Wallet.findOne({ user_id: req.user.id }).session(session)
        return res.json({ msg: 'Top-up already processed', balance: current.balance })
      }

      // 2) Tạo transaction record (immutable)
      await WalletTx.create([{
        wallet_id: wallet.id,
        user_id: req.user.id,
        type: 'TOPUP',
        amount,
        method,
        idempotency_key,
        meta: {}
      }], { session })

      // 3) Cập nhật số dư bằng $inc (atomic)
      updated = await Wallet.findOneAndUpdate(
        { id: wallet.id },
        { $inc: { balance: amount } },
        { new: true, session }
      )
    })

    res.json({ msg: 'Top-up success', balance: updated.balance })
  } catch (err) {
    // Nếu lỗi unique idempotency_key (đua tranh), coi như đã xử lý
    if (err?.code === 11000 && err?.keyPattern?.idempotency_key) {
      const wallet = await Wallet.findOne({ user_id: req.user.id })
      return res.json({ msg: 'Top-up already processed', balance: wallet?.balance })
    }
    res.status(400).json({ msg: err.message })
  } finally {
    session.endSession()
  }
}
