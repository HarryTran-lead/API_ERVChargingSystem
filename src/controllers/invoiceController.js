const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../utils/errors');
const { formatInvoiceDates } = require('../utils/timezoneHelpers');
const { notifyInvoiceChange } = require('../services/invoiceNotifier');
const { ensureRequestUserId } = require('../utils/requestUser');
const STATUS_SET = new Set(['ISSUED', 'VOID']);
const PAYMENT_STATUS_SET = new Set(['UNPAID', 'PAID', 'EXPIRED']);

const toPlain = (doc) =>
  doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;

const parseDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const buildInvoiceQuery = (params = {}) => {
  const query = {};
  if (params.userId) {
    query.user_id = params.userId;
  }
  if (params.sessionId) {
    query.session_id = params.sessionId;
  }
  if (params.status) {
    const statuses = String(params.status)
      .split(',')
      .map((token) => token.trim().toUpperCase())
      .filter((token) => STATUS_SET.has(token));
    if (statuses.length > 0) {
      query.status = { $in: statuses };
    }
  }
  if (params.paymentStatus) {
    const paymentStatuses = String(params.paymentStatus)
      .split(',')
      .map((token) => token.trim().toUpperCase())
      .filter((token) => PAYMENT_STATUS_SET.has(token));
    if (paymentStatuses.length > 0) {
      query.payment_status = { $in: paymentStatuses };
    }
  }
  const fromDate = parseDate(params.from);
  const toDate = parseDate(params.to);
  if (fromDate || toDate) {
    query.createdAt = {};
    if (fromDate) {
      query.createdAt.$gte = fromDate;
    }
    if (toDate) {
      query.createdAt.$lte = toDate;
    }
  }
  if (params.currency) {
    query.currency = params.currency;
  }
  return query;
};

const formatInvoice = (doc) => {
  if (!doc) return null;
  return formatInvoiceDates(toPlain(doc));
};


const findInvoiceByParam = async (param, session = null) => {
  const or = [{ id: param }, { session_id: param }];
  if (mongoose.Types.ObjectId.isValid(param)) {
    or.push({ _id: new mongoose.Types.ObjectId(param) });
  }
  const query = Invoice.findOne({ $or: or });
  if (session) {
    query.session(session);
  }
  return query;
};
exports.listMyInvoices = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const { page = 1, limit = 20, sort = '-createdAt', search } = req.query;
  const query = buildInvoiceQuery({ ...req.query, userId });

  if (search) {
    const keyword = String(search).trim();
    if (keyword) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      query.$or = [
        { id: keyword },
        { session_id: keyword },
        { currency: keyword },
        { id: { $regex: regex } },
      ];
    }
  }

  const pageNumber = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 20));
  const skip = (pageNumber - 1) * pageSize;

  const sortSpec = {};
  const sortFields = String(sort)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (sortFields.length === 0) {
    sortSpec.createdAt = -1;
  } else {
    sortFields.forEach((field) => {
      let direction = 1;
      let name = field;
      if (field.startsWith('-')) {
        direction = -1;
        name = field.slice(1);
      } else if (field.startsWith('+')) {
        name = field.slice(1);
      }
      if (['createdAt', 'updatedAt', 'issued_at', 'due_at', 'total'].includes(name)) {
        sortSpec[name] = direction;
      }
    });
    if (Object.keys(sortSpec).length === 0) {
      sortSpec.createdAt = -1;
    }
  }

  const [items, total] = await Promise.all([
    Invoice.find(query)
      .sort(sortSpec)
      .skip(skip)
      .limit(pageSize)
      .lean(),
    Invoice.countDocuments(query),
  ]);

  res.json({
    pagination: {
      page: pageNumber,
      limit: pageSize,
      total,
      pages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
    },
    items: items.map((invoice) => formatInvoice(invoice)),
  });
});

exports.getMyInvoice = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const invoice = await findInvoiceByParam(req.params.id);
  if (!invoice || invoice.user_id !== userId) {
    throw new HttpError(404, 'Invoice not found');
  }
  res.json({ invoice: formatInvoice(invoice) });
});

exports.listInvoices = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, sort = '-createdAt', search } = req.query;
  const query = buildInvoiceQuery(req.query);

  if (search) {
    const keyword = String(search).trim();
    if (keyword) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      query.$or = [
        { id: keyword },
        { session_id: keyword },
        { user_id: keyword },
        { currency: keyword },
        { id: { $regex: regex } },
      ];
    }
  }

  const pageNumber = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 20));
  const skip = (pageNumber - 1) * pageSize;

  const sortSpec = {};
  const sortFields = String(sort)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (sortFields.length === 0) {
    sortSpec.createdAt = -1;
  } else {
    sortFields.forEach((field) => {
      let direction = 1;
      let name = field;
      if (field.startsWith('-')) {
        direction = -1;
        name = field.slice(1);
      } else if (field.startsWith('+')) {
        name = field.slice(1);
      }
      if (['createdAt', 'updatedAt', 'issued_at', 'due_at', 'total'].includes(name)) {
        sortSpec[name] = direction;
      }
    });
    if (Object.keys(sortSpec).length === 0) {
      sortSpec.createdAt = -1;
    }
  }

  const [items, total] = await Promise.all([
    Invoice.find(query)
      .sort(sortSpec)
      .skip(skip)
      .limit(pageSize)
      .lean(),
    Invoice.countDocuments(query),
  ]);

  res.json({
    pagination: {
      page: pageNumber,
      limit: pageSize,
      total,
      pages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
    },
    items: items.map((invoice) => formatInvoice(invoice)),
  });
});

exports.getInvoice = asyncHandler(async (req, res) => {
  const invoice = await findInvoiceByParam(req.params.id);
  if (!invoice) {
    throw new HttpError(404, 'Invoice not found');
  }
  res.json({ invoice: formatInvoice(invoice) });
});

exports.updateInvoice = asyncHandler(async (req, res) => {
  const invoice = await findInvoiceByParam(req.params.id);
  if (!invoice) {
    throw new HttpError(404, 'Invoice not found');
  }

  const previousSnapshot = toPlain(invoice);
  const updates = {};
  const {
    status,
    paymentStatus,
    dueAt,
    paidAt,
    paidTotal,
    currency,
    meta,
  } = req.body;

  if (status != null) {
    const normalized = String(status).toUpperCase();
    if (!STATUS_SET.has(normalized)) {
      throw new HttpError(400, 'Unsupported invoice status');
    }
    updates.status = normalized;
  }

  if (paymentStatus != null) {
    const normalized = String(paymentStatus).toUpperCase();
    if (!PAYMENT_STATUS_SET.has(normalized)) {
      throw new HttpError(400, 'Unsupported payment status');
    }
    updates.payment_status = normalized;
    if (normalized === 'PAID') {
      updates.paid_at = paidAt ? parseDate(paidAt) || new Date() : new Date();
      if (paidTotal != null) {
        const amount = Number(paidTotal);
        if (!Number.isInteger(amount) || amount < 0) {
          throw new HttpError(400, 'paidTotal must be a non-negative integer');
        }
        updates.paid_total = amount;
      } else if (invoice.paid_total <= 0) {
        updates.paid_total = invoice.total;
      }
    } else {
      updates.paid_at = null;
      if (normalized === 'UNPAID') {
        updates.paid_total = paidTotal != null ? Number(paidTotal) : 0;
      }
    }
  }

  if (dueAt != null) {
    const parsed = parseDate(dueAt);
    if (!parsed) {
      throw new HttpError(400, 'Invalid dueAt value');
    }
    updates.due_at = parsed;
  }

  if (paidAt != null && !updates.paid_at) {
    const parsed = parseDate(paidAt);
    if (!parsed) {
      throw new HttpError(400, 'Invalid paidAt value');
    }
    updates.paid_at = parsed;
  }

  if (paidTotal != null && updates.paid_total == null) {
    const amount = Number(paidTotal);
    if (!Number.isInteger(amount) || amount < 0) {
      throw new HttpError(400, 'paidTotal must be a non-negative integer');
    }
    updates.paid_total = amount;
  }

  if (currency != null) {
    updates.currency = currency;
  }

  if (meta && typeof meta === 'object') {
    updates.meta = { ...invoice.meta, ...meta };
  }

  if (Object.keys(updates).length === 0) {
    throw new HttpError(400, 'No updates were provided');
  }

  await Invoice.updateOne({ _id: invoice._id }, { $set: updates });
  const refreshed = await Invoice.findById(invoice._id);
  await notifyInvoiceChange(previousSnapshot, refreshed);
  res.json({ invoice: formatInvoice(refreshed) });
});