const Connector = require("../models/Connector");
const Station = require("../models/Station");
const Booking = require("../models/Booking");
const Session = require("../models/Session");
const User = require("../models/User");
const Vehicle = require("../models/Vehicle");
const asyncHandler = require("../utils/asyncHandler");
const { HttpError } = require("../utils/errors");
const { ensureRequestUserId } = require("../utils/requestUser");
const { BOOKING_STATUS } = require("../constants/enums");
const { BOOKING_SLOT_MINUTES } = require("../constants/business");

exports.createConnector = asyncHandler(async (req, res) => {
  const { stationId, type, powerKw, status, code } = req.body;
  // validate station
  const st = await Station.findById(stationId).select("_id").lean();
  if (!st) throw new HttpError(400, "Invalid stationId");

  const c = await Connector.create({
    stationId,
    type,
    powerKw,
    status: status || "IDLE",
    code,
  });
  res.status(201).json(c);
});

exports.listConnectors = asyncHandler(async (req, res) => {
  const { stationId, status, page = 1, limit = 20 } = req.query;
  const q = {};
  if (stationId) q.stationId = stationId;
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
  res.json(doc);
});

exports.updateConnector = asyncHandler(async (req, res) => {
  const { type, powerKw, code } = req.body;
  const upd = {};
  if (type !== undefined) upd.type = type;
  if (powerKw !== undefined) upd.powerKw = powerKw;
  if (code !== undefined) upd.code = code;

  const doc = await Connector.findByIdAndUpdate(req.params.id, upd, {
    new: true,
  });
  if (!doc) throw new HttpError(404, "Connector not found");
  res.json(doc);
});

// PATCH status với rule: không cho OFFLINE khi đang CHARGING
exports.patchConnectorStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!status) throw new HttpError(400, "Missing status");

  const doc = await Connector.findById(req.params.id);
  if (!doc) throw new HttpError(404, "Connector not found");

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
  const done = await Connector.findByIdAndDelete(req.params.id);
  if (!done) throw new HttpError(404, "Connector not found");
  res.json({ ok: true });
});

const toPlain = (doc) =>
  typeof doc?.toObject === "function"
    ? doc.toObject()
    : typeof doc?.toJSON === "function"
    ? doc.toJSON()
    : doc;

const buildQrPayload = (token) => {
  if (!token) {
    return null;
  }

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

  return {
    id: connector._id?.toString(),
    code: connector.code,
    type: connector.type,
    powerKw: connector.powerKw,
    status: connector.status,
    station: stationPayload,
    qr: buildQrPayload(connector.qrToken),
  };
};

const computeEstimatedChargeMinutes = (booking, session) => {
  if (session?.chargeDurationMinutes) {
    return session.chargeDurationMinutes;
  }

  const start = booking?.slotStart ? new Date(booking.slotStart) : null;
  const end = booking?.slotEnd ? new Date(booking.slotEnd) : null;

  if (
    start &&
    end &&
    !Number.isNaN(start.getTime()) &&
    !Number.isNaN(end.getTime())
  ) {
    const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
    if (minutes > 0) {
      return minutes;
    }
  }

  return BOOKING_SLOT_MINUTES;
};

const formatSessionForScan = (sessionDoc) => {
  if (!sessionDoc) {
    return null;
  }
  const session = toPlain(sessionDoc);

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
  };
};

exports.getConnectorScanDetails = asyncHandler(async (req, res) => {
  const { token } = req.params;
  if (!token) {
    throw new HttpError(400, "Missing QR token");
  }

  const userId = ensureRequestUserId(req);

  const connector = await Connector.findOne({ qrToken: token })
    .populate("stationId", "name lat lng status")
    .lean();

  if (!connector) {
    throw new HttpError(404, "Connector not found");
  }

  const now = new Date();

  const booking = await Booking.findOne({
    connectorId: connector._id,
    userId,
    status: { $in: [BOOKING_STATUS.RESERVED, BOOKING_STATUS.CHECKED_IN] },
  })
    .sort({ slotStart: -1 })
    .lean();

  let userPayload = null;
  let bookingPayload = null;

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

    const estimatedMinutes = computeEstimatedChargeMinutes(booking, session);
    let finishAtFromSession = null;
    if (session?.expectedFullAt) {
      const parsed = new Date(session.expectedFullAt);
      if (!Number.isNaN(parsed.getTime())) {
        finishAtFromSession = parsed;
      }
    }

    const estimatedFinishAt = finishAtFromSession
      ? finishAtFromSession
      : booking.slotStart
      ? new Date(
          new Date(booking.slotStart).getTime() + estimatedMinutes * 60000
        )
      : null;

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

    let vehiclePayload = booking.vehicle ? { ...booking.vehicle } : null;
    let linkedVehicleDoc = null;

    if (booking.vehicleId) {
      linkedVehicleDoc = await Vehicle.findOne({
        id: booking.vehicleId,
        userId: booking.userId,
      })
        .select("id model plugType batteryKwh")
        .lean();

      if (linkedVehicleDoc) {
        vehiclePayload = {
          ...(vehiclePayload || {}),
          id: linkedVehicleDoc.id,
          model: linkedVehicleDoc.model,
          plugType: linkedVehicleDoc.plugType,
          batteryKwh: linkedVehicleDoc.batteryKwh,
        };
      }
    }

    bookingPayload = {
      id: booking._id?.toString(),
      ref: booking.id,
      status: booking.status,
      slotStart: booking.slotStart,
      slotEnd: booking.slotEnd,
      checkInDeadline: booking.checkInDeadline,
      estimatedChargeMinutes: estimatedMinutes,
      estimatedFinishAt,
      vehicleId: linkedVehicleDoc?.id || booking.vehicleId || undefined,
      vehicle: vehiclePayload,
      canStartNow,
      session: formatSessionForScan(session),
      estimatedRemainingMinutes,
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
