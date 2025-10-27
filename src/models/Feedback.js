const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const FeedbackSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true },
    userId: { type: String, ref: "User", required: true, index: true },
    bookingId: { type: String, ref: "Booking" },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

FeedbackSchema.index(
  { userId: 1, bookingId: 1 },
  {
    unique: true,
    partialFilterExpression: { bookingId: { $type: "string" } },
    name: "feedback_unique_booking",
  }
);

module.exports = mongoose.model("Feedback", FeedbackSchema);