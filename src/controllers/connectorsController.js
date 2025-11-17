// src/controllers/connectorsController.js
const mongoose = require("mongoose");

const Connector = require("../models/Connector");
const Station = require("../models/Station");
const Charger = require("../models/Charger");
const Booking = require("../models/Booking");
const Session = require("../models/Session");
const User = require("../models/User");
const asyncHandler = require("../utils/asyncHandler");
const { HttpError } = require("../utils/errors");
const { ensureRequestUserId } = require("../utils/requestUser");
const {
  resolveStaffStationScope,
  assertStaffStationAccess,
} = require("../utils/stationScope");
const {
  MAX_CONNECTORS_PER_CHARGER,
  BOOKING_SLOT_MINUTES,
} = require("../constants/business");
const { BOOKING_STATUS } = require("../constants/enums");
const {
  formatBookingDates,
  formatSessionDates,
} = require("../utils/timezoneHelpers");

exports.createConnector = asyncHandler(async (req, res) => {
  const { chargerId, status, code, type, powerKw } = req.body;

  if (type !== undefined || powerKw !== undefined) {
    throw new HttpError(
      400,
      "Connector type and power are managed by the charger configuration"
    );
  }
  const charger = await Charger.findById(chargerId)
    .select("_id stationId connectorType powerKw")
    .lean();
  if (!charger) {
    throw new HttpError(400, "Invalid chargerId");
  }

  assertStaffStationAccess(req, charger.stationId);

  if (!charger.connectorType) {
    throw new HttpError(409, "Charger is missing connector type configuration");
  }

  if (charger.powerKw === undefined || charger.powerKw === null) {
    throw new HttpError(409, "Charger is missing power configuration");
  }

  const st = await Station.findById(charger.stationId).select("_id").lean();
  if (!st) {
    throw new HttpError(409, "Charger is linked to an invalid station");
  }

  const connectorCount = await Connector.countDocuments({ chargerId });
  if (connectorCount >= MAX_CONNECTORS_PER_CHARGER) {
    throw new HttpError(
      409,
      `Charger already has ${MAX_CONNECTORS_PER_CHARGER} connectors`
    );
  }

  const c = await Connector.create({
    stationId: charger.stationId,
    chargerId,
    type: charger.connectorType,
    powerKw: charger.powerKw,
    status: status || "IDLE",
    code,
    qrToken: code,
  });
  const payload = c.toObject ? c.toObject() : c;
  payload.qr = buildQrPayload(payload.code);
  res.status(201).json(payload);
});

const toObjectId = (value) => {
  if (!value) return null;
  if (mongoose.Types.ObjectId.isValid(value)) {
    return new mongoose.Types.ObjectId(value);
  }
  return null;
};

exports.listConnectors = asyncHandler(async (req, res) => {
  const { stationObjectId } = resolveStaffStationScope(req);
  const { stationId, chargerId, status, page = 1, limit = 20 } = req.query;
  const q = {};

  if (stationObjectId) {
    q.stationId = stationObjectId;
  } else if (stationId) {
    const normalizedStationId = toObjectId(stationId);
    if (!normalizedStationId) {
      throw new HttpError(400, "Invalid stationId");
    }
    q.stationId = normalizedStationId;
  }

  if (chargerId) {
    const normalizedChargerId = toObjectId(chargerId);
    if (!normalizedChargerId) {
      throw new HttpError(400, "Invalid chargerId");
    }
    q.chargerId = normalizedChargerId;
  }
  if (status) q.status = status;

  const docs = await Connector.find(q)
    .skip((Number(page) - 1) * Number(limit))
    .limit(Number(limit))
    .lean();

  res.json(docs);
});

exports.getConnector = asyncHandler(async (req, res) => {
  const doc = await Connector.findById(req.params.id).lean();
  if (!doc) throw new HttpError(404, "Connector not found");

  assertStaffStationAccess(req, doc.stationId);
  res.json(doc);
});

exports.updateConnector = asyncHandler(async (req, res) => {
  const { code, type, powerKw } = req.body;

  if (type !== undefined || powerKw !== undefined) {
    throw new HttpError(
      400,
      "Connector type and power are managed by the charger configuration"
    );
  }
  const connector = await Connector.findById(req.params.id);
  if (!connector) throw new HttpError(404, "Connector not found");

  assertStaffStationAccess(req, connector.stationId);

  if (code !== undefined) connector.code = code;
  if (!connector.qrToken && connector.code) connector.qrToken = connector.code;

  const charger = await Charger.findById(connector.chargerId)
    .select("connectorType powerKw")
    .lean();
  if (!charger) {
    throw new HttpError(409, "Connector is linked to an invalid charger");
  }

  if (!charger.connectorType) {
    throw new HttpError(409, "Charger is missing connector type configuration");
  }

  if (charger.powerKw === undefined || charger.powerKw === null) {
    throw new HttpError(409, "Charger is missing power configuration");
  }

  connector.type = charger.connectorType;
  connector.powerKw = charger.powerKw;

  await connector.save();
  res.json(connector);
});

// PATCH status với rule: không cho OFFLINE khi đang CHARGING
exports.patchConnectorStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!status) throw new HttpError(400, "Missing status");

  const doc = await Connector.findById(req.params.id);
  if (!doc) throw new HttpError(404, "Connector not found");

  assertStaffStationAccess(req, doc.stationId);

  if (status === "OFFLINE" && doc.status === "CHARGING") {
    throw new HttpError(
      409,
      "Cannot set OFFLINE while CHARGING. Stop session first."
    );
  }

  doc.status = status;
  await doc.save();
  // TODO: broadcast socket.io update to console & app
  res.json(doc);
});

exports.deleteConnector = asyncHandler(async (req, res) => {
  const doc = await Connector.findById(req.params.id).select("_id stationId");
  if (!doc) throw new HttpError(404, "Connector not found");

  assertStaffStationAccess(req, doc.stationId);

  await Connector.deleteOne({ _id: doc._id });
  res.json({ ok: true });
});

// Helpers and new handler: connector scan by QR token (code)
const toPlain = (doc) =>
  typeof doc?.toObject === "function"
    ? doc.toObject()
    : typeof doc?.toJSON === "function"
    ? doc.toJSON()
    : doc;

const buildQrPayload = (token) => {
  if (!token) return null;
  const payload = { token };
  const baseUrl = process.env.CONNECTOR_QR_BASE_URL;
  if (baseUrl) {
    const sanitized = baseUrl.replace(/\/+$/, "");
    payload.url = `${sanitized}/${token}`;
  }
  return payload;
};

const formatConnectorForScan = (connectorDoc) => {
  const connector = toPlain(connectorDoc);
  const station = connector.stationId;
  const charger = connector.chargerId;

  const stationPayload = station
    ? {
        id:
          typeof station._id !== "undefined"
            ? station._id.toString()
            : station?.toString?.() || undefined,
        name: station.name,
        lat: station.lat,
        lng: station.lng,
        status: station.status,
      }
    : undefined;

  const chargerPayload = charger
    ? {
        id:
          typeof charger._id !== "undefined"
            ? charger._id.toString()
            : charger?.toString?.() || undefined,
        name: charger.name,
        code: charger.code,
        status: charger.status,
      }
    : undefined;

  return {
    id: connector._id?.toString(),
    code: connector.code,
    type: connector.type,
    powerKw: connector.powerKw,
    status: connector.status,
    station: stationPayload,
    charger: chargerPayload,
    qr: buildQrPayload(connector.code),
  };
};

const formatSessionForScan = (sessionDoc) => {
  if (!sessionDoc) return null;
  const session = formatSessionDates(toPlain(sessionDoc));
  return {
    id: session._id?.toString(),
    ref: session.id,
    status: session.status,
    startedAt: session.startedAt,
    expectedFullAt: session.expectedFullAt,
    stoppedAt: session.stoppedAt,
    chargeDurationMinutes: session.chargeDurationMinutes,
    totalChargingMinutes: session.totalChargingMinutes,
    totalIdleMinutes: session.totalIdleMinutes,
    socStart: session.socStart,
    socEnd: session.socEnd,
    socTarget: session.socTarget,
    pricing: session.pricing,
    billing: session.billing,
  };
};

const computeEstimatedChargeMinutes = (booking, session) => {
  if (session?.chargeDurationMinutes) return session.chargeDurationMinutes;
  const start = booking?.slotStart ? new Date(booking.slotStart) : null;
  const end = booking?.slotEnd ? new Date(booking.slotEnd) : null;
  if (
    start &&
    end &&
    !Number.isNaN(start.getTime()) &&
    !Number.isNaN(end.getTime())
  ) {
    const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
    if (minutes > 0) return minutes;
  }
  return BOOKING_SLOT_MINUTES;
};

exports.getConnectorScanDetails = asyncHandler(async (req, res) => {
  const { token } = req.params; // token = connector code
  if (!token) throw new HttpError(400, "Missing QR token");

  const userId = ensureRequestUserId(req);

  const connector = await Connector.findOne({ code: token })
    .populate("stationId", "name lat lng status")
    .populate("chargerId", "name code status")
    .lean();
  if (!connector) throw new HttpError(404, "Connector not found");

  assertStaffStationAccess(
    req,
    connector.stationId?._id || connector.stationId
  );

  let bookingPayload = null;
  let userPayload = null;

  const booking = await Booking.findOne({
    connectorId: connector._id,
    userId,
    status: { $in: [BOOKING_STATUS.RESERVED, BOOKING_STATUS.CHECKED_IN] },
  })
    .sort({ slotStart: -1 })
    .lean();

  if (booking) {
    const bookingUser = await User.findOne({ id: booking.userId })
      .select("id name email phone")
      .lean();
    if (bookingUser) {
      userPayload = {
        id: bookingUser.id,
        name: bookingUser.name,
        email: bookingUser.email,
        phone: bookingUser.phone,
      };
    }

    const session = await Session.findOne({ bookingId: booking._id }).lean();

    const formattedBooking = formatBookingDates(booking);
    const estimatedMinutes = computeEstimatedChargeMinutes(booking, session);

    let finishAtFromSession = null;
    if (session?.expectedFullAt) {
      const parsed = new Date(session.expectedFullAt);
      if (!Number.isNaN(parsed.getTime())) finishAtFromSession = parsed;
    }
    const estimatedFinishAt = finishAtFromSession
      ? finishAtFromSession
      : booking.slotStart
      ? new Date(
          new Date(booking.slotStart).getTime() + estimatedMinutes * 60000
        )
      : null;

    const now = new Date();
    let estimatedRemainingMinutes = null;
    if (estimatedFinishAt) {
      const diff = Math.ceil(
        (estimatedFinishAt.getTime() - now.getTime()) / 60000
      );
      estimatedRemainingMinutes = diff < 0 ? 0 : diff;
    }

    const canStartNow =
      booking.status === BOOKING_STATUS.RESERVED &&
      now >= new Date(booking.slotStart) &&
      now <= new Date(booking.checkInDeadline);

    bookingPayload = {
      id: booking._id?.toString(),
      ref: booking.id,
      status: booking.status,
      slotStart: formattedBooking.slotStart,
      slotEnd: formattedBooking.slotEnd,
      checkInDeadline: formattedBooking.checkInDeadline,
      estimatedChargeMinutes: estimatedMinutes,
      estimatedFinishAt,
      estimatedRemainingMinutes,
      connectorId: booking.connectorId?.toString(),
      canStartNow,
      session: formatSessionForScan(session),
    };

    if (canStartNow) {
      bookingPayload.startAction = {
        method: "POST",
        url: "/api/v1/sessions/start",
        body: { bookingId: booking.id },
      };
    }
  }

  res.json({
    connector: formatConnectorForScan(connector),
    user: userPayload,
    booking: bookingPayload,
  });
});
