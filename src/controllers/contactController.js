const ContactMessage = require('../models/ContactMessage');
const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../utils/errors');
const { ensureRequestUserId } = require('../utils/requestUser');

const STATUS_VALUES = ['new', 'in_progress', 'closed'];

const normalizeStatus = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return STATUS_VALUES.includes(normalized) ? normalized : null;
};

const cleanString = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

exports.createContactMessage = asyncHandler(async (req, res) => {
  const name = cleanString(req.body?.name);
  const email = cleanString(req.body?.email).toLowerCase();
  const phone = cleanString(req.body?.phone);
  const subject = cleanString(req.body?.subject);
  const message = cleanString(req.body?.message);

  if (!name) throw new HttpError(400, 'Name is required');
  if (!email) throw new HttpError(400, 'Email is required');
  if (!subject) throw new HttpError(400, 'Subject is required');
  if (!message) throw new HttpError(400, 'Message is required');

  const payload = { name, email, subject, message };
  if (phone) payload.phone = phone;

  if (req.user) {
    payload.userId = ensureRequestUserId(req);
  }

  const contactMessage = await ContactMessage.create(payload);

  res.status(201).json({
    msg: 'Message received',
    contactMessage,
  });
});

exports.getContactMessages = asyncHandler(async (req, res) => {
  const { status, userId, email } = req.query;
  const filter = {};

  if (status) {
    const statuses = String(status)
      .split(',')
      .map((value) => normalizeStatus(value))
      .filter(Boolean);
    if (statuses.length) {
      filter.status = { $in: statuses };
    } else {
      filter.status = '__never__';
    }
  }

  if (typeof userId === 'string' && userId.trim()) {
    filter.userId = userId.trim();
  }

  if (typeof email === 'string' && email.trim()) {
    filter.email = email.trim().toLowerCase();
  }

  const messages = await ContactMessage.find(filter)
    .sort({ createdAt: -1 })
    .lean();

  res.json({ messages });
});

exports.getContactMessageById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const contactMessage = await ContactMessage.findOne({ id }).lean();
  if (!contactMessage) {
    throw new HttpError(404, 'Contact message not found');
  }

  res.json({ contactMessage });
});

exports.updateContactMessage = asyncHandler(async (req, res) => {
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

  if (nextStatus && nextStatus !== 'new') {
    set.handledBy = req.user?.id || null;
    set.handledAt = new Date();
  } else if (nextStatus === 'new') {
    set.handledBy = null;
    set.handledAt = null;
  }

  if (!Object.keys(set).length && !Object.keys(unset).length) {
    throw new HttpError(400, 'Nothing to update');
  }

  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;

  const contactMessage = await ContactMessage.findOneAndUpdate({ id }, update, {
    new: true,
    runValidators: true,
  }).lean();

  if (!contactMessage) {
    throw new HttpError(404, 'Contact message not found');
  }

  res.json({
    msg: 'Contact message updated',
    contactMessage,
  });
});