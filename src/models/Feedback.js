const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const FeedbackSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true },
    userId: { type: String, ref: "User", required: true, index: true },
    bookingId: { type: String, ref: "Booking" },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, trim: true, maxlength: 2000 },

    // Trạng thái xử lý feedback
    status: {
      type: String,
      enum: ["pending", "in_progress", "resolved"],
      default: "pending",
      index: true,
    },

    // Ghi chú nội bộ của staff/admin khi xử lý
    note: { type: String, trim: true, maxlength: 2000 },

    // Ai xử lý feedback này
    handledBy: { type: String, ref: "User", index: true },

    // Thời điểm xử lý xong / cập nhật trạng thái
    handledAt: { type: Date },
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
