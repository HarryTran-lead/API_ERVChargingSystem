const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const planSchema = new mongoose.Schema({
  id: { type: String, default: uuidv4, unique: true },     // public id như User
  code: { type: String, required: true, unique: true, uppercase: true, trim: true }, // FREE/BASIC/PRO
  name: { type: String, required: true, trim: true, maxlength: 100 },
  monthly_fee_vnd: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', index: true },

  // Modifiers áp lên Tariff hiện hành
  mods: {
    pricePerKwhPctOff: { type: Number, default: 0, min: 0, max: 100 },
    pricePerMinPctOff: { type: Number, default: 0, min: 0, max: 100 },
    idleFeePerMinPctOff: { type: Number, default: 0, min: 0, max: 100 },
    graceMinBonus: { type: Number, default: 0, min: 0, max: 60 },
    minBalancePctOff: { type: Number, default: 0, min: 0, max: 100 },
    queueBoost: { type: Number, default: 0, min: 0, max: 10 }
  },

  created_at: { type: Date, default: Date.now }
});

// Helper trả về object modifiers đã “clamp”
planSchema.methods.getEffectiveMods = function () {
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n || 0)));
  return {
    pricePerKwhPctOff: clamp(this.mods?.pricePerKwhPctOff, 0, 100),
    pricePerMinPctOff: clamp(this.mods?.pricePerMinPctOff, 0, 100),
    idleFeePerMinPctOff: clamp(this.mods?.idleFeePerMinPctOff, 0, 100),
    graceMinBonus: clamp(this.mods?.graceMinBonus, 0, 60),
    minBalancePctOff: clamp(this.mods?.minBalancePctOff, 0, 100),
    queueBoost: clamp(this.mods?.queueBoost, 0, 10),
  };
};

module.exports = mongoose.model('MembershipPlan', planSchema);
