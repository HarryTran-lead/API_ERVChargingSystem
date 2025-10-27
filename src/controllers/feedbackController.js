const Feedback = require("../models/Feedback");
const Booking = require("../models/Booking");
const asyncHandler = require("../utils/asyncHandler");
const { HttpError } = require("../utils/errors");
const { ensureRequestUserId } = require("../utils/requestUser");

const normalizeRating = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 10) / 10; // giữ 1 chữ số thập phân nếu cần
};

exports.createFeedback = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const { rating, comment, bookingId } = req.body;

  const parsedRating = normalizeRating(rating);
  if (parsedRating === null) {
    throw new HttpError(400, "rating must be a numeric value");
  }
  if (parsedRating < 1 || parsedRating > 5) {
    throw new HttpError(400, "rating must be between 1 and 5");
  }

  let bookingRef;
  if (bookingId) {
    const booking = await Booking.findOne({ id: bookingId, userId }).select("id");
    if (!booking) {
      throw new HttpError(404, "Booking not found for this user");
    }
    bookingRef = booking.id;
    const existing = await Feedback.findOne({ userId, bookingId: bookingRef }).lean();
    if (existing) {
      throw new HttpError(409, "Feedback already submitted for this booking");
    }
  }

  const payload = {
    userId,
    rating: parsedRating,
  };

  const trimmedComment = typeof comment === "string" ? comment.trim() : "";
  if (trimmedComment) {
    payload.comment = trimmedComment;
  }
  if (bookingRef) {
    payload.bookingId = bookingRef;
  }

  const feedback = await Feedback.create(payload);
  const response = feedback.toObject();

  res.status(201).json({
    msg: "Feedback submitted",
    feedback: response,
  });
});

exports.getMyFeedbacks = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);

  const feedbacks = await Feedback.find({ userId })
    .sort({ createdAt: -1 })
    .lean();

  res.json({ feedbacks });
});

exports.getAllFeedbacks = asyncHandler(async (req, res) => {
  const feedbacks = await Feedback.find()
    .sort({ createdAt: -1 })
    .lean();

  res.json({ feedbacks });
  });