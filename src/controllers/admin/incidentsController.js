const mongoose = require('mongoose');
const StationIncident = require('../../models/StationIncident');
const asyncHandler = require('../../utils/asyncHandler');
const { HttpError } = require('../../utils/errors');
const { formatToVietnamTime } = require('../../utils/timezoneHelpers');
const { INCIDENT_SEVERITY, INCIDENT_STATUS } = require('../../constants/enums');

const INCIDENT_SEVERITY_SET = new Set(INCIDENT_SEVERITY);
const INCIDENT_STATUS_SET = new Set(INCIDENT_STATUS);

const toPlain = (doc) =>
  doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;

const toObjectId = (value) => {
  if (!value) return null;
  if (mongoose.Types.ObjectId.isValid(value)) {
    return new mongoose.Types.ObjectId(value);
  }
  return null;
};

const parseDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const parseSeverity = (raw) => {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter((token) => INCIDENT_SEVERITY_SET.has(token));
};

const parseStatuses = (raw) => {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter((token) => INCIDENT_STATUS_SET.has(token));
};

const formatIncident = (doc) => {
  const plain = toPlain(doc);
  if (!plain) return null;
  return {
    id: plain.id,
    stationId: plain.stationId?.toString() || null,
    connectorId: plain.connectorId?.toString() || null,
    reportedBy: plain.reportedBy,
    title: plain.title,
    description: plain.description,
    severity: plain.severity,
    status: plain.status,
    attachments: Array.isArray(plain.attachments) ? plain.attachments : [],
    resolvedBy: plain.resolvedBy || null,
    resolvedAt: plain.resolvedAt ? formatToVietnamTime(plain.resolvedAt) : null,
    meta: plain.meta || null,
    createdAt: formatToVietnamTime(plain.createdAt),
    updatedAt: formatToVietnamTime(plain.updatedAt),
  };
};

const buildIncidentQuery = (reference) => {
  if (!reference) return null;
  const or = [{ id: reference }];
  if (mongoose.Types.ObjectId.isValid(reference)) {
    or.push({ _id: new mongoose.Types.ObjectId(reference) });
  }
  return { $or: or };
};

exports.listIncidentReports = asyncHandler(async (req, res) => {
  const {
    status,
    stationId,
    severity,
    from,
    to,
    page = 1,
    limit = 20,
  } = req.query || {};

  const filter = {};
  const statuses = parseStatuses(status);
  if (statuses.length) filter.status = { $in: statuses };

  const severities = parseSeverity(severity);
  if (severities.length) filter.severity = { $in: severities };

  if (stationId) {
    const objectId = toObjectId(stationId);
    if (objectId) filter.stationId = objectId;
  }

  const fromDate = parseDate(from);
  const toDate = parseDate(to);
  if (fromDate || toDate) {
    filter.createdAt = {};
    if (fromDate) filter.createdAt.$gte = fromDate;
    if (toDate) filter.createdAt.$lte = toDate;
  }

  const pageNumber = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 20));
  const skip = (pageNumber - 1) * pageSize;

  const [items, total] = await Promise.all([
    StationIncident.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .lean(),
    StationIncident.countDocuments(filter),
  ]);

  res.json({
    pagination: {
      page: pageNumber,
      limit: pageSize,
      total,
      pages: pageSize ? Math.ceil(total / pageSize) : 0,
    },
    items: items.map(formatIncident),
  });
});

exports.markIncidentInProgress = asyncHandler(async (req, res) => {
  const incidentId = req.params.id;
  const query = buildIncidentQuery(incidentId);
  if (!query) {
    throw new HttpError(400, 'Invalid incident identifier');
  }

  const updates = {
    status: 'IN_PROGRESS',
    resolvedBy: undefined,
    resolvedAt: null,
  };

  const incident = await StationIncident.findOneAndUpdate(query, { $set: updates }, { new: true });
  if (!incident) {
    throw new HttpError(404, 'Incident not found');
  }

  res.json({
    message: 'Incident marked as IN_PROGRESS',
    incident: formatIncident(incident),
  });
});