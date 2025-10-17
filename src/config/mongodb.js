// src/config/mongodb.js
const mongoose = require('mongoose')

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    })
    console.log('MongoDB connected')
    try {
      const collection = mongoose.connection.db.collection("connectors");
      await collection.dropIndex("qrToken_1");
      console.log("Dropped legacy connectors.qrToken index");
    } catch (err) {
      if (
        err?.codeName === "IndexNotFound" ||
        err?.code === 27 ||
        err?.code === 26
      ) {
        // Index or collection already absent – nothing to do.
      } else {
        console.warn("Failed to drop legacy connectors.qrToken index", err);
      }
    }
  } catch (err) {
    console.error('MongoDB connection error', err)
    process.exit(1)
  }
}

module.exports = connectDB
