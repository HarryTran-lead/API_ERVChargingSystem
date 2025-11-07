// src/controllers/staff/staffOperationsController.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Station = require('../../models/Station');
const Connector = require('../../models/Connector');
const Charger = require('../../models/Charger');
const Booking = require('../../models/Booking');
const Session = require('../../models/Session');
const Invoice = require('../../models/Invoice');
const OnsitePayment = require('../../models/OnsitePayment');
const StationIncident = require('../../models/StationIncident');

const asyncHandler = require('../../utils/asyncHandler');
const { HttpError } = require('../../utils/errors');
const { ensureRequestUser, ensureRequestUserId } = require('../../utils/requestUser');
const {
  formatInvoiceDates,
  formatBookingDates,
  formatSessionDates,
  formatToVietnamTime,
} = require('../../utils/timezoneHelpers');
const {
  INCIDENT_SEVERITY,
  INCIDENT_STATUS,
  CONNECTOR_STATUS,
  BOOKING_STATUS,
  BOOKING_STATUS_VALUES,
  SESSION_STATUS,
  SESSION_STATUS_VALUES,
  PAYMENT_METHODS,
  ROLES,
} = require('../../constants/enums');
const { BOOKING_SLOT_MINUTES, BOOKING_GRACE_MINUTES } = require('../../constants/business');
const { notifyInvoiceChange } = require('../../services/invoiceNotifier');
const { scheduleNoShowJob } = require('../../services/bookingScheduler');
const bookingMonitor = require('../../services/bookingMonitor');
const { safeNotifyUser } = require('../../services/notificationService');

const INCIDENT_SEVERITY_SET = new Set(INCIDENT_SEVERITY);
const INCIDENT_STATUS_SET = new Set(INCIDENT_STATUS);
const CONNECTOR_STATUS_SET = new Set(CONNECTOR_STATUS);
const BOOKING_STATUS_SET = new Set(Object.values(BOOKING_STATUS));
const SESSION_STATUS_SET = new Set(Object.values(SESSION_STATUS));
const DEFAULT_OPERATIONAL_BOOKING_STATUSES = [...BOOKING_STATUS_VALUES];
const DEFAULT_OPERATIONAL_SESSION_STATUSES = [...SESSION_STATUS_VALUES];
const PAYMENT_METHOD_SET = new Set(Object.values(PAYMENT_METHODS));
const INVOICE_STATUS_SET = new Set(['ISSUED', 'VOID']);
const INVOICE_PAYMENT_STATUS_SET = new Set(['UNPAID', 'PAID', 'EXPIRED']);

const toPlain = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject() : doc);

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

const parseObjectIdList = (raw) => {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((token) => token.trim())
    .map(toObjectId)
    .filter(Boolean);
};

const parseBookingStatuses = (raw) => {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter((token) => BOOKING_STATUS_SET.has(token));
};

const parseSessionStatuses = (raw) => {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter((token) => SESSION_STATUS_SET.has(token));
};

const parseInvoiceStatuses = (raw) => {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter((token) => INVOICE_STATUS_SET.has(token));
};

const parseInvoicePaymentStatuses = (raw) => {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter((token) => INVOICE_PAYMENT_STATUS_SET.has(token));
};

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : fallback;
};

const normalizePaymentMethod = (value) => {
  if (!value) return PAYMENT_METHODS.WALLET;
  const normalized = String(value).trim().toUpperCase();
  if (!PAYMENT_METHOD_SET.has(normalized)) {
    throw new HttpError(400, 'Unsupported payment method');
  }
  return normalized;
};

const sanitizeString = (value) => {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text || undefined;
};

const sanitizeVehicleSnapshot = (input) => {
  if (!input || typeof input !== 'object') return undefined;
  const snapshot = {
    id: sanitizeString(input.id),
    make: sanitizeString(input.make),
    model: sanitizeString(input.model),
    plugType: sanitizeString(input.plugType),
    licensePlate: sanitizeString(input.licensePlate),
  };

  const battery = Number(input.batteryKwh);
  if (Number.isFinite(battery) && battery > 0) {
    snapshot.batteryKwh = battery;
  }

  const entries = Object.entries(snapshot).filter(([, v]) => v != null);
  return entries.length ? Object.fromEntries(entries) : undefined;
};

const sanitizeWalkInInfo = (input) => {
  if (!input || typeof input !== 'object') return undefined;
  const info = {
    name: sanitizeString(input.name),
    phone: sanitizeString(input.phone),
    note: sanitizeString(input.note),
  };
  const entries = Object.entries(info).filter(([, v]) => v);
  return entries.length ? Object.fromEntries(entries) : undefined;
};

const parseSortSpec = (raw, allowed, fallback) => {
  if (!raw) return fallback;
  const spec = {};
  String(raw)
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .forEach((token) => {
      let direction = 1;
      let field = token;
      if (token.startsWith('-')) {
        direction = -1;
        field = token.slice(1);
      } else if (token.startsWith('+')) {
        field = token.slice(1);
      }
      if (allowed.has(field)) {
        spec[field] = direction;
      }
    });
  return Object.keys(spec).length ? spec : fallback;
};

const buildInvoiceLookup = ({ sessionId, invoiceId }) => {
  const or = [];
  if (invoiceId) {
    or.push({ id: invoiceId });
    if (mongoose.Types.ObjectId.isValid(invoiceId)) {
      or.push({ _id: new mongoose.Types.ObjectId(invoiceId) });
    }
  }
  if (sessionId) {
    or.push({ session_id: sessionId });
  }
  return or;
};

const buildIncidentQuery = (reference) => {
  if (!reference) return null;
  const or = [{ id: reference }];
  if (mongoose.Types.ObjectId.isValid(reference)) {
    or.push({ _id: new mongoose.Types.ObjectId(reference) });
  }
  return { $or: or };
};

const formatConnector = (doc) => {
  if (!doc) return null;
  return {
    id: doc._id?.toString() || null,
    stationId: doc.stationId?.toString() || null,
    chargerId: doc.chargerId?.toString() || null,
    code: doc.code,
    status: doc.status,
    type: doc.type,
    powerKw: doc.powerKw,
    updatedAt: doc.updatedAt,
  };
};

const formatCharger = (doc) => {
  if (!doc) return null;
  return {
    id: doc._id?.toString() || null,
    stationId: doc.stationId?.toString() || null,
    name: doc.name,
    code: doc.code,
    status: doc.status,
    powerKw: doc.powerKw,
    connectorType: doc.connectorType,
    updatedAt: doc.updatedAt,
  };
};

const formatStation = (doc) => {
  if (!doc) return null;
  return {
    id: doc._id?.toString() || null,
    name: doc.name,
    status: doc.status,
    lat: doc.lat,
    lng: doc.lng,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
};

const formatPayment = (doc) => {
  const plain = toPlain(doc);
  if (!plain) return null;
  return {
    id: plain.id,
    invoiceId: plain.invoiceId?.toString() || null,
    invoiceRef: plain.invoiceRef,
    sessionRef: plain.sessionRef,
    userId: plain.userId,
    staffId: plain.staffId,
    amount: plain.amount,
    currency: plain.currency,
    method: plain.method,
    note: plain.note,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
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
    resolvedAt: plain.resolvedAt || null,
    meta: plain.meta || null,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
};

const formatOperationalBooking = (doc) => {
  if (!doc) return null;
  const booking = formatBookingDates(toPlain(doc));
  const session = booking.session ? formatSessionDates(booking.session) : null;
  const station = booking.station || null;
  const connector = booking.connector || null;
  const user = booking.user || null;

  return {
    id: booking.id || booking._id?.toString() || null,
    reference: booking.id || booking._id?.toString() || null,
    status: booking.status,
    slotStart: booking.slotStart,
    slotEnd: booking.slotEnd,
    userId: booking.userId,
    paymentMethod: booking.paymentMethod || PAYMENT_METHODS.WALLET,
    createdByStaffId: booking.createdByStaffId || null,
    walkInInfo: booking.walkInInfo || null,
    vehicle: booking.vehicle || null,
    station: station
      ? {
          id: station._id?.toString() || null,
          name: station.name,
          code: station.code,
          status: station.status,
        }
      : null,
    connector: connector
      ? {
          id: connector._id?.toString() || null,
          code: connector.code,
          status: connector.status,
          type: connector.type,
          powerKw: connector.powerKw,
        }
      : null,
    user: user
      ? {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
        }
      : null,
    session: session
      ? {
          id: session.id,
          status: session.status,
          paymentMethod: session.paymentMethod,
          startedAt: session.startedAt,
          stoppedAt: session.stoppedAt,
        }
      : null,
    createdAt: booking.createdAt,
    updatedAt: booking.updatedAt,
  };
};

const formatOperationalSession = (doc) => {
  if (!doc) return null;
  const session = formatSessionDates(toPlain(doc));
  const booking = session.booking ? formatBookingDates(session.booking) : null;
  const station = session.station || null;
  const connector = session.connector || null;
  const user = session.user || null;

  return {
    id: session.id,
    bookingRef: session.bookingRef || booking?.id || booking?._id?.toString() || null,
    status: session.status,
    paymentMethod: session.paymentMethod,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    expectedFullAt: session.expectedFullAt,
    operatorId: session.operatorId || null,
    stoppedBy: session.stoppedBy || null,
    userId: session.userId,
    station: station
      ? {
          id: station._id?.toString() || null,
          name: station.name,
          code: station.code,
          status: station.status,
        }
      : null,
    connector: connector
      ? {
          id: connector._id?.toString() || null,
          code: connector.code,
          status: connector.status,
          type: connector.type,
          powerKw: connector.powerKw,
        }
      : null,
    booking: booking
      ? {
          id: booking.id || booking._id?.toString() || null,
          status: booking.status,
          slotStart: booking.slotStart,
          slotEnd: booking.slotEnd,
          userId: booking.userId,
          paymentMethod: booking.paymentMethod || PAYMENT_METHODS.WALLET,
          walkInInfo: booking.walkInInfo || null,
        }
      : null,
    user: user
      ? {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
        }
      : null,
    walkInInfo: session.walkInInfo || null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
};

const normalizeIncidentSeverity = (value) => {
  if (!value) return 'MEDIUM';
  const normalized = String(value).trim().toUpperCase();
  if (!INCIDENT_SEVERITY_SET.has(normalized)) {
    throw new HttpError(400, 'Unsupported incident severity');
  }
  return normalized;
};

const normalizeIncidentStatus = (value) => {
  if (!value) return null;
  const normalized = String(value).trim().toUpperCase();
  if (!INCIDENT_STATUS_SET.has(normalized)) {
    throw new HttpError(400, 'Unsupported incident status');
  }
  return normalized;
};

const sumBy = (items, predicate) => items.reduce((total, item) => total + (predicate(item) || 0), 0);

/* ======================= STATION STATUS ======================= */

exports.listStationStatuses = asyncHandler(async (req, res) => {
  ensureRequestUser(req);
  const { stationId } = req.query;

  const identifiers = [];
  if (stationId) {
    String(stationId)
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean)
      .forEach((token) => {
        const objectId = toObjectId(token);
        if (objectId) identifiers.push(objectId);
      });
  }

  const stationFilter = identifiers.length ? { _id: { $in: identifiers } } : {};

  const stations = await Station.find(stationFilter).lean();
  if (!stations.length) {
    return res.json({ stations: [] });
  }

  const stationIds = stations.map((s) => s._id);
  const [connectors, chargers] = await Promise.all([
    Connector.find({ stationId: { $in: stationIds } })
      .select('stationId chargerId code status type powerKw updatedAt')
      .lean(),
    Charger.find({ stationId: { $in: stationIds } })
      .select('stationId name code status powerKw connectorType updatedAt')
      .lean(),
  ]);

  const connectorByStation = new Map();
  connectors.forEach((connector) => {
    const key = connector.stationId?.toString();
    if (!connectorByStation.has(key)) {
      connectorByStation.set(key, []);
    }
    connectorByStation.get(key).push(connector);
  });

  const chargerByStation = new Map();
  chargers.forEach((charger) => {
    const key = charger.stationId?.toString();
    if (!chargerByStation.has(key)) {
      chargerByStation.set(key, []);
    }
    chargerByStation.get(key).push(charger);
  });

  const response = stations.map((stationDoc) => {
    const station = formatStation(stationDoc);
    const stationKey = station.id;
    const connectorsForStation = connectorByStation.get(stationKey) || [];
    const chargersForStation = chargerByStation.get(stationKey) || [];

    const statusCounts = connectorsForStation.reduce((acc, item) => {
      const status = CONNECTOR_STATUS_SET.has(item.status) ? item.status : 'UNKNOWN';
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});

    const totalPower = sumBy(connectorsForStation, (item) => item.powerKw);
    const chargingPower = sumBy(connectorsForStation, (item) =>
      item.status === 'CHARGING' ? item.powerKw : 0
    );
    const availablePower = sumBy(connectorsForStation, (item) =>
      item.status === 'IDLE' ? item.powerKw : 0
    );

    const lastUpdated = connectorsForStation.reduce((latest, item) => {
      const timestamp = item.updatedAt ? new Date(item.updatedAt).getTime() : 0;
      return timestamp > latest ? timestamp : latest;
    }, 0);

    return {
      station,
      metrics: {
        totalConnectors: connectorsForStation.length,
        statusCounts,
        powerKw: {
          total: totalPower,
          charging: chargingPower,
          available: availablePower,
        },
        lastUpdatedAt: lastUpdated ? new Date(lastUpdated) : null,
      },
      connectors: connectorsForStation.map(formatConnector),
      chargers: chargersForStation.map(formatCharger),
    };
  });

  res.json({ stations: response });
});

/* ======================= ONSITE PAYMENT ======================= */

exports.recordOnsitePayment = asyncHandler(async (req, res) => {
  ensureRequestUser(req);
  const staffId = ensureRequestUserId(req);
  const { sessionId, invoiceId, amount, method, note } = req.body || {};

  if (!sessionId && !invoiceId) {
    throw new HttpError(400, 'sessionId or invoiceId is required');
  }

  const lookup = buildInvoiceLookup({ sessionId, invoiceId });
  if (!lookup.length) {
    throw new HttpError(400, 'Invalid invoice reference provided');
  }

  const normalizedMethod = String(method || 'CASH').trim().toUpperCase();

  const txn = await mongoose.startSession();
  let paymentRecord = null;
  let invoiceBefore = null;
  let invoiceAfter = null;

  try {
    await txn.withTransaction(async () => {
      const invoice = await Invoice.findOne({ $or: lookup }).session(txn);
      if (!invoice) {
        throw new HttpError(404, 'Invoice not found for the provided reference');
      }
      if (invoice.payment_status === 'PAID') {
        throw new HttpError(409, 'Invoice is already marked as paid');
      }

      invoiceBefore = invoice.toObject();

      const totalAmount = amount != null ? Number(amount) : Number(invoice.total || 0);
      if (!Number.isInteger(totalAmount) || totalAmount < 0) {
        throw new HttpError(400, 'amount must be a non-negative integer');
      }

      invoice.payment_status = 'PAID';
      invoice.paid_at = new Date();
      invoice.paid_total = totalAmount;
      invoice.meta = {
        ...(invoice.meta || {}),
        onsitePayment: {
          staffId,
          method: normalizedMethod,
          recordedAt: new Date(),
        },
      };

      await invoice.save({ session: txn });
      invoiceAfter = invoice.toObject();

      const created = await OnsitePayment.create(
        [
          {
            invoiceId: invoice._id,
            invoiceRef: invoice.id,
            sessionRef: invoice.session_id,
            userId: invoice.user_id,
            staffId,
            amount: totalAmount,
            currency: invoice.currency,
            method: normalizedMethod,
            note: note ? String(note).trim() : undefined,
          },
        ],
        { session: txn }
      );
      paymentRecord = formatPayment(created[0]);
    });
  } catch (error) {
    if (error && error.code === 11000) {
      throw new HttpError(409, 'An onsite payment has already been recorded');
    }
    throw error;
  } finally {
    txn.endSession();
  }

  if (invoiceBefore && invoiceAfter) {
    await notifyInvoiceChange(invoiceBefore, invoiceAfter);
  }

  res.status(201).json({
    message: 'Onsite payment recorded',
    payment: paymentRecord,
    invoice: invoiceAfter ? formatInvoiceDates(invoiceAfter) : null,
  });
});

/* ======================= PROXY BOOKING (STAFF) ======================= */

exports.createProxyBooking = asyncHandler(async (req, res) => {
  ensureRequestUser(req);
  const staffId = ensureRequestUserId(req);
  const {
    connectorId,
    slotStart,
    durationMinutes,
    userId,
    guest,
    vehicle,
    paymentMethod: rawPaymentMethod,
  } = req.body || {};

  if (!connectorId || !slotStart) {
    throw new HttpError(400, 'connectorId and slotStart are required');
  }

  const start = new Date(slotStart);
  if (Number.isNaN(start.getTime())) {
    throw new HttpError(400, 'Invalid slotStart value');
  }

  const normalizedStart = new Date(start);
  normalizedStart.setSeconds(0, 0);

  const maxDuration = BOOKING_SLOT_MINUTES;
  const duration = Math.max(5, Math.min(maxDuration, Number(durationMinutes) || maxDuration));
  const slotEnd = new Date(normalizedStart.getTime() + duration * 60 * 1000);
  const checkInDeadline = new Date(normalizedStart.getTime() + BOOKING_GRACE_MINUTES * 60 * 1000);

  const normalizedUserId = sanitizeString(userId);
  const walkInInfo = sanitizeWalkInInfo(guest);
  const targetUserId = normalizedUserId || `guest:${uuidv4()}`;

  const paymentMethod = normalizePaymentMethod(rawPaymentMethod);
  if (!normalizedUserId && paymentMethod !== PAYMENT_METHODS.ONSITE) {
    throw new HttpError(400, 'Guests without an account must use ONSITE payment method');
  }

  const vehicleSnapshot = sanitizeVehicleSnapshot(vehicle);

  const overlapping = await Booking.findOne({
    connectorId,
    status: { $in: [BOOKING_STATUS.RESERVED, BOOKING_STATUS.CHECKED_IN] },
    slotStart: { $lt: slotEnd },
    slotEnd: { $gt: normalizedStart },
  }).lean();

  if (overlapping) {
    throw new HttpError(409, 'Connector already reserved for the selected slot');
  }

  let connectorDoc;
  try {
    connectorDoc = await Connector.findOneAndUpdate(
      { _id: connectorId, status: 'IDLE' },
      { $set: { status: 'RESERVED' } },
      { new: true }
    );

    if (!connectorDoc) {
      throw new HttpError(409, 'Connector is not available');
    }

    const booking = await Booking.create({
      userId: targetUserId,
      stationId: connectorDoc.stationId,
      connectorId,
      slotStart: normalizedStart,
      slotEnd,
      checkInDeadline,
      status: BOOKING_STATUS.RESERVED,
      vehicleId: vehicleSnapshot?.id,
      vehicle: vehicleSnapshot,
      paymentMethod,
      createdByStaffId: staffId,
      walkInInfo,
    });

    scheduleNoShowJob(booking);
    bookingMonitor.syncBooking(booking);

    if (normalizedUserId) {
      await safeNotifyUser({
        userId: targetUserId,
        title: 'Booking created by station staff',
        body: `A booking ${booking.id} has been created on your behalf for ${formatToVietnamTime(
          booking.slotStart
        )}.`,
        type: 'booking',
        data: {
          bookingId: booking.id,
          status: booking.status,
          slotStart: formatToVietnamTime(booking.slotStart),
          slotEnd: formatToVietnamTime(booking.slotEnd),
          paymentMethod,
        },
      });
    }

    res.status(201).json({
      message: 'Booking created by staff',
      booking: formatBookingDates(booking),
      proxyUserId: targetUserId,
    });
  } catch (error) {
    if (connectorDoc) {
      await Connector.findByIdAndUpdate(connectorDoc._id, { $set: { status: 'IDLE' } });
    }
    throw error;
  }
});

/* ======================= INCIDENTS ======================= */

exports.reportIncident = asyncHandler(async (req, res) => {
  const actor = ensureRequestUser(req);
  const staffId = ensureRequestUserId(req);
  const { stationId, connectorId, title, description, severity, attachments, meta } = req.body || {};

  if (!stationId) {
    throw new HttpError(400, 'stationId is required');
  }
  if (!description) {
    throw new HttpError(400, 'description is required');
  }

  const payload = {
    stationId,
    connectorId: connectorId || undefined,
    reportedBy: staffId,
    title: title ? String(title).trim() : undefined,
    description: String(description).trim(),
    severity: normalizeIncidentSeverity(severity),
    attachments: Array.isArray(attachments)
      ? attachments.map((item) => String(item)).filter(Boolean)
      : [],
  };
  if (meta && typeof meta === 'object') {
    payload.meta = meta;
  }

  const incident = await StationIncident.create(payload);
  res.status(201).json({
    message: 'Incident reported',
    incident: formatIncident(incident),
  });
});

exports.listIncidentReports = asyncHandler(async (req, res) => {
  ensureRequestUser(req);
  const { status, stationId, severity, page = 1, limit = 20 } = req.query;

  const filter = {};
  if (status) {
    const statuses = String(status)
      .split(',')
      .map((token) => token.trim().toUpperCase())
      .filter((token) => INCIDENT_STATUS_SET.has(token));
    if (statuses.length) filter.status = { $in: statuses };
  }
  if (stationId) {
    const objectId = toObjectId(stationId);
    if (objectId) filter.stationId = objectId;
  }
  if (severity) {
    const severities = String(severity)
      .split(',')
      .map((token) => token.trim().toUpperCase())
      .filter((token) => INCIDENT_SEVERITY_SET.has(token));
    if (severities.length) filter.severity = { $in: severities };
  }

  const pageNumber = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 20));
  const skip = (pageNumber - 1) * pageSize;

  const [items, total] = await Promise.all([
    StationIncident.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    StationIncident.countDocuments(filter),
  ]);

  res.json({
    pagination: {
      page: pageNumber,
      limit: pageSize,
      total,
      pages: Math.ceil(total / pageSize),
    },
    items: items.map(formatIncident),
  });
});

exports.updateIncidentStatus = asyncHandler(async (req, res) => {
  const actor = ensureRequestUser(req);
  const staffId = ensureRequestUserId(req);
  const { status } = req.body || {};
  const incidentId = req.params.id;

  const normalizedStatus = normalizeIncidentStatus(status);
  if (!normalizedStatus) {
    throw new HttpError(400, 'status is required');
  }

  // Role-based rules
  const actorRole = actor?.role || ROLES.STAFF;
  const allowedStatuses = actorRole === ROLES.ADMIN ? ['IN_PROGRESS'] : ['OPEN', 'RESOLVED'];
  if (!allowedStatuses.includes(normalizedStatus)) {
    throw new HttpError(403, 'You are not allowed to set this status');
  }

  const query = buildIncidentQuery(incidentId);
  if (!query) {
    throw new HttpError(400, 'Invalid incident identifier');
  }

  const updates = { status: normalizedStatus };

  if (normalizedStatus === 'RESOLVED') {
    updates.resolvedBy = staffId;
    updates.resolvedAt = new Date();
  } else if (normalizedStatus === 'IN_PROGRESS') {
    updates.resolvedBy = undefined;
    updates.resolvedAt = null;
  } else if (normalizedStatus === 'OPEN') {
    updates.resolvedBy = undefined;
    updates.resolvedAt = null;
  }

  const incident = await StationIncident.findOneAndUpdate(query, { $set: updates }, { new: true });
  if (!incident) {
    throw new HttpError(404, 'Incident not found');
  }

  res.json({
    message: 'Incident status updated',
    incident: formatIncident(incident),
  });
});

/* ======================= OPERATIONAL LISTS ======================= */

exports.listOperationalBookings = asyncHandler(async (req, res) => {
  ensureRequestUser(req);
  const { status, stationId, from, to, search, page = 1, limit = 20, sort } = req.query || {};

  const statuses = parseBookingStatuses(status);
  const stationIds = parseObjectIdList(stationId);
  const startDate = parseDate(from);
  const endDate = parseDate(to);

  const baseMatch = {
    status: { $in: statuses.length ? statuses : DEFAULT_OPERATIONAL_BOOKING_STATUSES },
  };

  if (stationIds.length) {
    baseMatch.stationId = { $in: stationIds };
  }

  if (startDate || endDate) {
    baseMatch.slotStart = {};
    if (startDate) baseMatch.slotStart.$gte = startDate;
    if (endDate) baseMatch.slotStart.$lte = endDate;
  }

  const filters = [];
  if (Object.keys(baseMatch).length) {
    filters.push(baseMatch);
  }

  const keyword = search ? String(search).trim() : '';
  if (keyword) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    filters.push({
      $or: [
        { id: keyword },
        { userId: keyword },
        { 'vehicle.licensePlate': keyword },
        { 'vehicle.licensePlate': { $regex: regex } },
      ],
    });
  }

  const matchStage = filters.length > 1 ? { $and: filters } : filters[0] || null;

  const allowedSort = new Set(['slotStart', 'slotEnd', 'createdAt', 'updatedAt']);
  const sortSpec = parseSortSpec(sort, allowedSort, { slotStart: 1, createdAt: -1 });

  const pageNumber = parsePositiveInteger(page, 1);
  const pageSize = Math.min(100, parsePositiveInteger(limit, 20));
  const skip = (pageNumber - 1) * pageSize;

  const pipeline = [];
  if (matchStage) pipeline.push({ $match: matchStage });

  pipeline.push({
    $facet: {
      metadata: [{ $count: 'total' }],
      items: [
        { $sort: sortSpec },
        { $skip: skip },
        { $limit: pageSize },
        {
          $lookup: {
            from: 'stations',
            localField: 'stationId',
            foreignField: '_id',
            as: 'station',
          },
        },
        { $unwind: { path: '$station', preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: 'connectors',
            localField: 'connectorId',
            foreignField: '_id',
            as: 'connector',
          },
        },
        { $unwind: { path: '$connector', preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: 'users',
            localField: 'userId',
            foreignField: 'id',
            as: 'user',
          },
        },
        { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: 'sessions',
            localField: '_id',
            foreignField: 'bookingId',
            as: 'session',
          },
        },
        { $unwind: { path: '$session', preserveNullAndEmptyArrays: true } },
      ],
    },
  });

  pipeline.push({
    $project: {
      total: { $ifNull: [{ $first: '$metadata.total' }, 0] },
      items: 1,
    },
  });

  const [result] = await Booking.aggregate(pipeline);
  const total = result?.total || 0;
  const items = (result?.items || []).map(formatOperationalBooking);

  res.json({
    pagination: {
      page: pageNumber,
      limit: pageSize,
      total,
      pages: pageSize ? Math.ceil(total / pageSize) : 0,
    },
    items,
  });
});

exports.listOperationalSessions = asyncHandler(async (req, res) => {
  ensureRequestUser(req);
  const {
    status,
    stationId,
    connectorId,
    bookingId,
    from,
    to,
    search,
    page = 1,
    limit = 20,
    sort,
  } = req.query || {};

  const statuses = parseSessionStatuses(status);
  const stationIds = parseObjectIdList(stationId);
  const connectorIds = parseObjectIdList(connectorId);
  const startDate = parseDate(from);
  const endDate = parseDate(to);

  const baseMatch = {
    status: { $in: statuses.length ? statuses : DEFAULT_OPERATIONAL_SESSION_STATUSES },
  };

  if (stationIds.length) {
    baseMatch.stationId = stationIds.length === 1 ? stationIds[0] : { $in: stationIds };
  }
  if (connectorIds.length) {
    baseMatch.connectorId = connectorIds.length === 1 ? connectorIds[0] : { $in: connectorIds };
  }

  if (startDate || endDate) {
    baseMatch.startedAt = {};
    if (startDate) baseMatch.startedAt.$gte = startDate;
    if (endDate) baseMatch.startedAt.$lte = endDate;
  }

  if (bookingId) {
    const bookingObjectId = toObjectId(bookingId);
    if (bookingObjectId) {
      baseMatch.bookingId = bookingObjectId;
    } else {
      baseMatch.bookingRef = bookingId;
    }
  }

  const filters = [];
  if (Object.keys(baseMatch).length) {
    filters.push(baseMatch);
  }

  const keyword = search ? String(search).trim() : '';
  if (keyword) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    filters.push({
      $or: [{ id: keyword }, { bookingRef: keyword }, { userId: keyword }, { id: { $regex: regex } }],
    });
  }

  const matchStage = filters.length > 1 ? { $and: filters } : filters[0] || null;

  const allowedSort = new Set(['startedAt', 'stoppedAt', 'createdAt', 'updatedAt']);
  const sortSpec = parseSortSpec(sort, allowedSort, { startedAt: -1, createdAt: -1 });

  const pageNumber = parsePositiveInteger(page, 1);
  const pageSize = Math.min(100, parsePositiveInteger(limit, 20));
  const skip = (pageNumber - 1) * pageSize;

  const pipeline = [];
  if (matchStage) pipeline.push({ $match: matchStage });

  pipeline.push({
    $facet: {
      metadata: [{ $count: 'total' }],
      items: [
        { $sort: sortSpec },
        { $skip: skip },
        { $limit: pageSize },
        {
          $lookup: {
            from: 'bookings',
            localField: 'bookingId',
            foreignField: '_id',
            as: 'booking',
          },
        },
        { $unwind: { path: '$booking', preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: 'stations',
            localField: 'stationId',
            foreignField: '_id',
            as: 'station',
          },
        },
        { $unwind: { path: '$station', preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: 'connectors',
            localField: 'connectorId',
            foreignField: '_id',
            as: 'connector',
          },
        },
        { $unwind: { path: '$connector', preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: 'users',
            localField: 'userId',
            foreignField: 'id',
            as: 'user',
          },
        },
        { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      ],
    },
  });

  pipeline.push({
    $project: {
      total: { $ifNull: [{ $first: '$metadata.total' }, 0] },
      items: 1,
    },
  });

  const [result] = await Session.aggregate(pipeline);
  const total = result?.total || 0;
  const items = (result?.items || []).map(formatOperationalSession);

  res.json({
    pagination: {
      page: pageNumber,
      limit: pageSize,
      total,
      pages: pageSize ? Math.ceil(total / pageSize) : 0,
    },
    items,
  });
});

/* ======================= INVOICES ======================= */

exports.listInvoices = asyncHandler(async (req, res) => {
  ensureRequestUser(req);
  const {
    page = 1,
    limit = 20,
    sort = '-createdAt',
    search,
    status,
    paymentStatus,
    userId,
    sessionId,
    from,
    to,
  } = req.query || {};

  const filter = {};
  if (userId) filter.user_id = userId;
  if (sessionId) filter.session_id = sessionId;

  const statuses = parseInvoiceStatuses(status);
  if (statuses.length) filter.status = { $in: statuses };

  const paymentStatuses = parseInvoicePaymentStatuses(paymentStatus);
  if (paymentStatuses.length) filter.payment_status = { $in: paymentStatuses };

  const fromDate = parseDate(from);
  const toDate = parseDate(to);
  if (fromDate || toDate) {
    filter.createdAt = {};
    if (fromDate) filter.createdAt.$gte = fromDate;
    if (toDate) filter.createdAt.$lte = toDate;
  }

  if (search) {
    const keyword = String(search).trim();
    if (keyword) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [
        { id: keyword },
        { session_id: keyword },
        { user_id: keyword },
        { currency: keyword },
        { id: { $regex: regex } },
      ];
    }
  }

  const pageNumber = parsePositiveInteger(page, 1);
  const pageSize = Math.min(100, parsePositiveInteger(limit, 20));
  const skip = (pageNumber - 1) * pageSize;

  const allowedSort = new Set(['createdAt', 'updatedAt', 'issued_at', 'due_at', 'total']);
  const sortSpec = parseSortSpec(sort, allowedSort, { createdAt: -1 });

  const [items, total] = await Promise.all([
    Invoice.find(filter).sort(sortSpec).skip(skip).limit(pageSize).lean(),
    Invoice.countDocuments(filter),
  ]);

  res.json({
    pagination: {
      page: pageNumber,
      limit: pageSize,
      total,
      pages: pageSize ? Math.ceil(total / pageSize) : 0,
    },
    items: items.map((invoice) => formatInvoiceDates(invoice)),
  });
});

exports.getSessionInvoice = asyncHandler(async (req, res) => {
  ensureRequestUser(req);
  const { id } = req.params;

  const session = await Session.findOne({
    $or: [{ id }, { _id: toObjectId(id) }],
  });

  if (!session) {
    throw new HttpError(404, 'Session not found');
  }

  const invoice = await Invoice.findOne({ session_id: session.id });
  if (!invoice) {
    throw new HttpError(404, 'Invoice not found for this session');
  }

  res.json({
    session: formatSessionDates(session),
    invoice: formatInvoiceDates(invoice),
  });
});
