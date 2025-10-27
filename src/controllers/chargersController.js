const Charger = require("../models/Charger");
const Station = require("../models/Station");
const Booking = require("../models/Booking");
const Session = require("../models/Session");
const User = require("../models/User");
const Vehicle = require("../models/Vehicle");
const Connector = require("../models/Connector");
const asyncHandler = require("../utils/asyncHandler");
const { HttpError } = require("../utils/errors");
const { ensureRequestUserId } = require("../utils/requestUser");
const { BOOKING_STATUS } = require("../constants/enums");
const { BOOKING_SLOT_MINUTES } = require("../constants/business");
const {
  formatBookingDates,
  formatSessionDates,
} = require("../utils/timezoneHelpers");

exports.createCharger = asyncHandler(async (req, res) => {
  const { stationId, name, code, status, connectorType, powerKw } = req.body;
  const station = await Station.findById(stationId).select("_id").lean();
  if (!station) {
    throw new HttpError(400, "Invalid stationId");
  }

  const charger = await Charger.create({
    stationId,
    name,
    code,
    connectorType,
    powerKw,
    status: status || "ONLINE",
  });

  res.status(201).json(charger);
});

exports.listChargers = asyncHandler(async (req, res) => {
  const { stationId, status, page = 1, limit = 20 } = req.query;
  const q = {};
  if (stationId) q.stationId = stationId;
  if (status) q.status = status;

  const chargers = await Charger.find(q)
    .skip((Number(page) - 1) * Number(limit))
    .limit(Number(limit))
    .lean();

  // Lấy tất cả connectors cho các chargers
  const chargerIds = chargers.map((charger) => charger._id);
  const connectors = await Connector.find({
    chargerId: { $in: chargerIds },
  }).lean();

  // Nhóm connectors theo chargerId
  const connectorsByCharger = {};
  connectors.forEach((connector) => {
    const chargerId = connector.chargerId.toString();
    if (!connectorsByCharger[chargerId]) {
      connectorsByCharger[chargerId] = [];
    }
    connectorsByCharger[chargerId].push(connector);
  });

  // Thêm connectors vào mỗi charger
  const chargersWithConnectors = chargers.map((charger) => ({
    ...charger,
    connectors: connectorsByCharger[charger._id.toString()] || [],
  }));

  res.json(chargersWithConnectors);
});

exports.getCharger = asyncHandler(async (req, res) => {
  const charger = await Charger.findById(req.params.id).lean();
  if (!charger) {
    throw new HttpError(404, "Charger not found");
  }

  // Lấy tất cả connectors của charger này
  const connectors = await Connector.find({ chargerId: charger._id }).lean();

  // Thêm connectors vào charger
  const chargerWithConnectors = {
    ...charger,
    connectors: connectors,
  };

  res.json(chargerWithConnectors);
});

exports.updateCharger = asyncHandler(async (req, res) => {
  const { name, code, status, connectorType, powerKw } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (code !== undefined) updates.code = code;
  if (status !== undefined) updates.status = status;
  if (connectorType !== undefined) updates.connectorType = connectorType;
  if (powerKw !== undefined) updates.powerKw = powerKw;

  const charger = await Charger.findByIdAndUpdate(req.params.id, updates, {
    new: true,
  });

  if (!charger) {
    throw new HttpError(404, "Charger not found");
  }

  const connectorUpdates = {};
  if (connectorType !== undefined)
    connectorUpdates.type = charger.connectorType;
  if (powerKw !== undefined) connectorUpdates.powerKw = charger.powerKw;
  if (Object.keys(connectorUpdates).length > 0) {
    await Connector.updateMany({ chargerId: charger._id }, connectorUpdates);
  }

  res.json(charger);
});

exports.deleteCharger = asyncHandler(async (req, res) => {
  const connectorCount = await Connector.countDocuments({
    chargerId: req.params.id,
  });

  if (connectorCount > 0) {
    throw new HttpError(409, "Cannot delete charger with existing connectors");
  }

  const deleted = await Charger.findByIdAndDelete(req.params.id);
  if (!deleted) {
    throw new HttpError(404, "Charger not found");
  }

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
  const baseUrl =
    process.env.CHARGER_QR_BASE_URL || process.env.CONNECTOR_QR_BASE_URL;
  if (baseUrl) {
    const sanitized = baseUrl.replace(/\/+$/, "");
    payload.url = `${sanitized}/${token}`;
  }
  return payload;
};

const formatSessionForScan = (sessionDoc) => {
  if (!sessionDoc) {
    return null;
  }

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
  };
};

const formatChargerForScan = (chargerDoc) => {
  const charger = toPlain(chargerDoc);
  const station = charger.stationId;

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
    id: charger._id?.toString(),
    name: charger.name,
    code: charger.code,
    status: charger.status,
    station: stationPayload,
    qr: buildQrPayload(charger.qrToken),
  };
};

exports.getChargerScanDetails = asyncHandler(async (req, res) => {
  const { token } = req.params;
  if (!token) {
    throw new HttpError(400, "Missing QR token");
  }

  const userId = ensureRequestUserId(req);

  const charger = await Charger.findOne({ qrToken: token })
    .populate("stationId", "name lat lng status")
    .lean();

  if (!charger) {
    throw new HttpError(404, "Charger not found");
  }

  const connectors = await Connector.find({ chargerId: charger._id })
    .populate("stationId", "name lat lng status")
    .lean();

  const connectorIds = connectors.map((c) => c._id);

  let formattedConnectors = [];
  let userPayload = null;
  let bookingPayload = null;

  if (connectorIds.length > 0) {
    const booking = await Booking.findOne({
      connectorId: { $in: connectorIds },
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

      const bookingConnector = connectors.find(
        (c) =>
          booking.connectorId &&
          c._id?.toString() === booking.connectorId.toString()
      );

      const formattedBooking = formatBookingDates(booking);
      bookingPayload = {
        id: booking._id?.toString(),
        ref: booking.id,
        status: booking.status,
        slotStart: formattedBooking.slotStart,
        slotEnd: formattedBooking.slotEnd,
        checkInDeadline: formattedBooking.checkInDeadline,
        estimatedChargeMinutes: estimatedMinutes,
        estimatedFinishAt,
        vehicleId: linkedVehicleDoc?.id || booking.vehicleId || undefined,
        vehicle: vehiclePayload,
        canStartNow,
        session: formatSessionForScan(session),
        estimatedRemainingMinutes,
        connectorId: booking.connectorId?.toString(),
      };

      if (bookingConnector) {
        bookingPayload.connector = formatConnectorForScan(bookingConnector);
      }

      if (canStartNow) {
        bookingPayload.startAction = {
          method: "POST",
          url: "/api/v1/sessions/start",
          body: { bookingId: booking.id },
        };
      }

      formattedConnectors = connectors.map((connectorDoc) => {
        const formatted = formatConnectorForScan(connectorDoc);
        if (
          booking.connectorId &&
          connectorDoc._id?.toString() === booking.connectorId.toString()
        ) {
          return { ...formatted, isBookedConnector: true };
        }
        return formatted;
      });
    }
  }

  res.json({
    charger: formatChargerForScan(charger),
    connectors: formattedConnectors,
    user: userPayload,
    booking: bookingPayload,
  });
});
