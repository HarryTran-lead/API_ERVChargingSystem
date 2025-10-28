require('dotenv').config();               // <-- NẠP .env
const mongoose = require('mongoose');
const path = require('path');

// import model đúng path khi chạy từ project root
const MembershipPlan = require(path.join(__dirname, '..', 'src', 'models', 'MembershipPlan'));

(async () => {
  try {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error('Missing MONGO_URI');
    await mongoose.connect(uri);
    console.log('[seed] connected to', mongoose.connection.name);

    await MembershipPlan.deleteMany({});
    await MembershipPlan.create([
      { code:'FREE',  name:'Free',  monthly_fee_vnd:0,     status:'ACTIVE', mods:{} },
      { code:'BASIC', name:'Basic', monthly_fee_vnd:49000, status:'ACTIVE',
        mods:{ pricePerKwhPctOff:5, pricePerMinPctOff:10, idleFeePerMinPctOff:10, graceMinBonus:5, minBalancePctOff:0, queueBoost:1 } },
      { code:'PRO',   name:'Pro',   monthly_fee_vnd:129000,status:'ACTIVE',
        mods:{ pricePerKwhPctOff:10, pricePerMinPctOff:20, idleFeePerMinPctOff:30, graceMinBonus:10, minBalancePctOff:20, queueBoost:2 } },
    ]);

    const docs = await MembershipPlan.find({}).select('code monthly_fee_vnd status');
    console.log('[seed] plans:', docs);
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
