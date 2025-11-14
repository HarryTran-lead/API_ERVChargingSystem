const Feedback = require('../models/Feedback');
const Booking = require('../models/Booking');
const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../utils/errors');
const { ensureRequestUserId } = require('../utils/requestUser');
const { safeNotifyUser } = require('../services/notificationService');

const ALLOWED_STATUSES = ['pending', 'in_progress', 'resolved'];

const normalizeRating = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 10) / 10; // giữ 1 chữ số thập phân nếu cần
};

const normalizeStatus = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return ALLOWED_STATUSES.includes(normalized) ? normalized : null;
};

exports.createFeedback = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const { rating, comment, bookingId } = req.body;

  const parsedRating = normalizeRating(rating);
  if (parsedRating === null) {
    throw new HttpError(400, 'rating must be a numeric value');
  }
  if (parsedRating < 1 || parsedRating > 5) {
    throw new HttpError(400, 'rating must be between 1 and 5');
  }

  let bookingRef;
  if (bookingId) {
    const booking = await Booking.findOne({ id: bookingId, userId }).select('id');
    if (!booking) {
      throw new HttpError(404, 'Booking not found for this user');
    }
    bookingRef = booking.id;
    const existing = await Feedback.findOne({ userId, bookingId: bookingRef }).lean();
    if (existing) {
      throw new HttpError(409, 'Feedback already submitted for this booking');
    }
  }

  const payload = {
    userId,
    rating: parsedRating,
  };

  const trimmedComment = typeof comment === 'string' ? comment.trim() : '';
  if (trimmedComment) {
    payload.comment = trimmedComment;
  }
  if (bookingRef) {
    payload.bookingId = bookingRef;
  }

  const feedback = await Feedback.create(payload);
  const response = feedback.toObject();

  await safeNotifyUser({
    userId,
    title: 'Thank you for your feedback',
    body: `We have received your ${parsedRating}-star feedback${
      bookingRef ? ` for booking ${bookingRef}` : ''
    }.`,
    type: 'system',
    data: {
      feedbackId: feedback.id,
      bookingId: bookingRef || null,
      rating: parsedRating,
    },
  });

  res.status(201).json({
    msg: 'Feedback submitted',
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
  const filter = {};
  const { status, userId, bookingId, handledBy } = req.query;

  if (status) {
    const statuses = String(status)
      .split(',')
      .map((item) => normalizeStatus(item))
      .filter(Boolean);

    if (statuses.length) {
      filter.status = { $in: statuses };
    } else {
      // nếu query status toàn giá trị sai -> trả về empty list
      filter.status = '__never__';
    }
  }

  if (typeof userId === 'string' && userId.trim()) {
    filter.userId = userId.trim();
  }

  if (typeof bookingId === 'string' && bookingId.trim()) {
    filter.bookingId = bookingId.trim();
  }

  if (typeof handledBy === 'string' && handledBy.trim()) {
    filter.handledBy = handledBy.trim();
  }

  const feedbacks = await Feedback.find(filter)
    .sort({ createdAt: -1 })
    .lean();

  res.json({ feedbacks });
});

exports.getFeedbackById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const feedback = await Feedback.findOne({ id }).lean();
  if (!feedback) {
    throw new HttpError(404, 'Feedback not found');
  }

  res.json({ feedback });
});

exports.updateFeedback = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, note } = req.body || {};

  const set = {};
  const unset = {};
  let nextStatus;

  if (typeof status !== 'undefined') {
    const normalizedStatus = normalizeStatus(status);
    if (!normalizedStatus) {
      throw new HttpError(400, 'Invalid status value');
    }
    nextStatus = normalizedStatus;
    set.status = normalizedStatus;
  }

  if (typeof note === 'string') {
    const trimmedNote = note.trim();
    if (trimmedNote) {
      set.note = trimmedNote;
    } else {
      unset.note = 1;
    }
  } else if (note === null) {
    unset.note = 1;
  }

  if (nextStatus && nextStatus !== 'pending') {
    set.handledBy = req.user?.id || null;
    set.handledAt = new Date();
  } else if (nextStatus === 'pending') {
    set.handledBy = null;
    set.handledAt = null;
  }

  if (!Object.keys(set).length && !Object.keys(unset).length) {
    throw new HttpError(400, 'Nothing to update');
  }

  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;

  const feedback = await Feedback.findOneAndUpdate({ id }, update, {
    new: true,
    runValidators: true,
  }).lean();

  if (!feedback) {
    throw new HttpError(404, 'Feedback not found');
  }

  res.json({
    msg: 'Feedback updated',
    feedback,
  });
});
