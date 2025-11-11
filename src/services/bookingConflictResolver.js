const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Connector = require("../models/Connector");
const Station = require("../models/Station");
const Session = require("../models/Session");
const { BOOKING_STATUS, SESSION_STATUS } = require("../constants/enums");
const { BOOKING_GRACE_MINUTES } = require("../constants/business");
const { scheduleNoShowJob } = require("./bookingScheduler");
const bookingMonitor = require("./bookingMonitor");
const { formatBookingDates } = require("../utils/timezoneHelpers");
const { HttpError } = require("../utils/errors");
const { safeNotifyUser } = require("./notificationService");

const ACTIVE_SESSION_STATUSES = [
  SESSION_STATUS.PENDING,
  SESSION_STATUS.CHARGING,
];
const ACTIVE_BOOKING_STATUSES = [
  BOOKING_STATUS.RESERVED,
  BOOKING_STATUS.CHECKED_IN,
];

const toObjectId = (value) => {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (mongoose.Types.ObjectId.isValid(value)) {
    return new mongoose.Types.ObjectId(value);
  }
  return null;
};

const toPlain = (doc) => {
  if (!doc) return null;
  if (typeof doc.toObject === "function") {
    return doc.toObject();
  }
  if (doc._doc) {
    return { ...doc._doc };
  }
  return { ...doc };
};

const toDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const minutesBetween = (start, end) => {
  const from = toDate(start);
  const to = toDate(end);
  if (!from || !to) return BOOKING_GRACE_MINUTES;
  const diff = Math.round((to.getTime() - from.getTime()) / 60000);
  return diff > 0 ? diff : BOOKING_GRACE_MINUTES;
};

const haversineDistanceKm = (lat1, lng1, lat2, lng2) => {
  if (
    typeof lat1 !== "number" ||
    typeof lng1 !== "number" ||
    typeof lat2 !== "number" ||
    typeof lng2 !== "number"
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const detectConflict = async (booking) => {
  const slotStart = toDate(booking.slotStart);
  if (!slotStart) {
    return { conflict: false };
  }

  const now = new Date();
  if (now < slotStart) {
    return { conflict: false };
  }

  const connectorId = booking.connectorId;
  if (!connectorId) {
    return { conflict: true, reason: "MISSING_CONNECTOR" };
  }

  const conflictingSession = await Session.findOne({
    connectorId,
    bookingId: { $ne: booking._id },
    status: { $in: ACTIVE_SESSION_STATUSES },
  })
    .sort({ startedAt: -1 })
    .lean();

  if (conflictingSession) {
    return {
      conflict: true,
      reason: "ACTIVE_SESSION",
      session: conflictingSession,
    };
  }

  const connector = await Connector.findById(connectorId).lean();
  if (!connector) {
    return { conflict: true, reason: "MISSING_CONNECTOR" };
  }

  if (connector.status !== "RESERVED") {
    return { conflict: true, reason: "CONNECTOR_STATUS", connector };
  }

  const overlappingBooking = await Booking.findOne({
    _id: { $ne: booking._id },
    connectorId,
    status: { $in: ACTIVE_BOOKING_STATUSES },
    slotStart: { $lt: booking.slotEnd },
    slotEnd: { $gt: booking.slotStart },
  }).lean();

  if (overlappingBooking) {
    return {
      conflict: true,
      reason: "BOOKING_OVERLAP",
      booking: overlappingBooking,
    };
  }

  return { conflict: false };
};

const listStationConnectorsForWindow = async (
  stationId,
  slotStart,
  slotEnd,
  excludeBookingId
) => {
  const filters = { stationId };
  const connectors = await Connector.find(filters).lean();
  if (connectors.length === 0) return [];

  const bookings = await Booking.find({
    stationId,
    _id: { $ne: excludeBookingId },
    status: { $in: ACTIVE_BOOKING_STATUSES },
    slotStart: { $lt: slotEnd },
    slotEnd: { $gt: slotStart },
  })
    .select("connectorId")
    .lean();

  const blocked = new Set(
    bookings.map((b) => b.connectorId?.toString?.()).filter(Boolean)
  );

  return connectors.filter((connector) => {
    if (blocked.has(connector._id.toString())) {
      return false;
    }
    return connector.status === "IDLE" || connector.status === "FINISHED";
  });
};

const findSameStationAlternative = async (booking) => {
  const slotStart = toDate(booking.slotStart);
  const slotEnd = toDate(booking.slotEnd);
  if (!slotStart || !slotEnd) return null;

  const connectors = await listStationConnectorsForWindow(
    booking.stationId,
    slotStart,
    slotEnd,
    booking._id
  );

  const currentId = booking.connectorId?.toString?.();
  return connectors.find((c) => c._id.toString() !== currentId) || null;
};

const findNearestStationSuggestion = async (booking) => {
  const slotStart = toDate(booking.slotStart);
  const slotEnd = toDate(booking.slotEnd);
  if (!slotStart || !slotEnd) return null;

  const baseStation = await Station.findById(booking.stationId).lean();
  if (!baseStation) return null;

  const candidateStations = await Station.find({
    _id: { $ne: booking.stationId },
    status: "ONLINE",
  }).lean();

  let best = null;
  for (const station of candidateStations) {
    const available = await listStationConnectorsForWindow(
      station._id,
      slotStart,
      slotEnd,
      booking._id
    );
    if (available.length === 0) {
      continue;
    }

    const distanceKm = haversineDistanceKm(
      baseStation.lat,
      baseStation.lng,
      station.lat,
      station.lng
    );
    if (!best || distanceKm < best.distanceKm) {
      best = {
        station,
        connectors: available,
        distanceKm,
      };
    }
  }

  if (!best) return null;

  return {
    station: best.station,
    connectors: best.connectors,
    distanceKm: best.distanceKm,
    slotStart,
    slotEnd,
  };
};

const findNextSlotSuggestion = async (booking) => {
  const currentStart = toDate(booking.slotStart);
  const currentEnd = toDate(booking.slotEnd);
  if (!currentStart || !currentEnd) return null;

  const slotMinutes = minutesBetween(currentStart, currentEnd);
  const nextStart = new Date(currentEnd.getTime());
  nextStart.setSeconds(0, 0);

  const now = new Date();
  let effectiveStart = new Date(nextStart.getTime());
  while (effectiveStart < now) {
    effectiveStart = new Date(effectiveStart.getTime() + slotMinutes * 60000);
  }
  effectiveStart.setSeconds(0, 0);
  const effectiveEnd = new Date(effectiveStart.getTime() + slotMinutes * 60000);

  const available = await listStationConnectorsForWindow(
    booking.stationId,
    effectiveStart,
    effectiveEnd,
    booking._id
  );

  if (available.length === 0) {
    return null;
  }

  return {
    slotStart: effectiveStart,
    slotEnd: effectiveEnd,
    connectors: available,
  };
};

const reserveConnector = async (connectorId) => {
  const updated = await Connector.findOneAndUpdate(
    { _id: connectorId, status: { $in: ["IDLE", "FINISHED"] } },
    { $set: { status: "RESERVED" } },
    { new: true }
  );
  return updated;
};

const releaseConnector = async (connectorId) => {
  if (!connectorId) return;
  await Connector.findOneAndUpdate(
    { _id: connectorId, status: "RESERVED" },
    { $set: { status: "IDLE" } }
  );
};

const applyBookingUpdate = async (
  booking,
  { stationId, connectorId, slotStart, slotEnd }
) => {
  let reservedConnector = null;
  if (connectorId) {
    reservedConnector = await reserveConnector(connectorId);
    if (!reservedConnector) {
      throw new HttpError(409, "Selected connector is no longer available");
    }
  }

  const update = {};
  if (stationId) update.stationId = toObjectId(stationId) || stationId;
  if (connectorId) update.connectorId = toObjectId(connectorId) || connectorId;
  if (slotStart) update.slotStart = slotStart;
  if (slotEnd) update.slotEnd = slotEnd;
  if (slotStart) {
    update.checkInDeadline = new Date(
      slotStart.getTime() + BOOKING_GRACE_MINUTES * 60 * 1000
    );
  }

  const updatedBooking = await Booking.findOneAndUpdate(
    { _id: booking._id, status: BOOKING_STATUS.RESERVED },
    { $set: update },
    { new: true }
  );

  if (!updatedBooking) {
    if (reservedConnector) {
      await releaseConnector(connectorId);
    }
    throw new HttpError(409, "Booking could not be updated");
  }

  if (
    connectorId &&
    booking.connectorId?.toString() !== connectorId.toString()
  ) {
    await releaseConnector(booking.connectorId);
  }

  scheduleNoShowJob(updatedBooking);
  bookingMonitor.syncBooking(updatedBooking);

  return updatedBooking;
};

const buildConnectorPayload = (connector) => {
  if (!connector) return null;
  const plain = toPlain(connector);
  if (!plain) return null;
  return {
    id: plain._id?.toString?.() || plain.id || null,
    code: plain.code,
    type: plain.type,
    powerKw: plain.powerKw,
    status: plain.status,
  };
};

const buildStationPayload = (station) => {
  if (!station) return null;
  const plain = toPlain(station);
  if (!plain) return null;
  return {
    id: plain._id?.toString?.() || plain.id || null,
    name: plain.name,
    lat: plain.lat,
    lng: plain.lng,
    status: plain.status,
  };
};

const notifyBookingChange = async (booking, message) => {
  if (!booking?.userId) return;
  await safeNotifyUser({
    userId: booking.userId,
    title: "Booking update",
    body: message,
    type: "booking",
    data: {
      bookingId: booking.id,
      slotStart: booking.slotStart,
      slotEnd: booking.slotEnd,
      stationId: booking.stationId?.toString?.() || null,
      connectorId: booking.connectorId?.toString?.() || null,
    },
  });
};

const resolveConflict = async ({ booking, decision }) => {
  const conflict = await detectConflict(booking);
  if (!conflict.conflict) {
    return {
      state: "no_conflict",
      message: "Connector is ready for the reserved slot.",
      booking: formatBookingDates(toPlain(booking)),
    };
  }

  const sameStation = await findSameStationAlternative(booking);
  if (sameStation) {
    const updated = await applyBookingUpdate(booking, {
      connectorId: sameStation._id,
    });
    const latestConnector = await Connector.findById(
      updated.connectorId
    ).lean();
    const stationDoc = await Station.findById(updated.stationId).lean();
    await notifyBookingChange(
      updated,
      `Connector unavailable. Automatically moved to connector ${sameStation.code} at the same station.`
    );
    return {
      state: "auto_reassigned",
      message: `Automatically reassigned to connector ${sameStation.code} at the same station.`,
      booking: formatBookingDates(toPlain(updated)),
      context: {
        connector: buildConnectorPayload(latestConnector || sameStation),
        station: buildStationPayload(stationDoc),
      },
    };
  }

  const decisionType = decision?.type;

  if (decisionType !== "REJECT_STATION") {
    const stationSuggestion = await findNearestStationSuggestion(booking);
    if (stationSuggestion) {
      if (decisionType === "ACCEPT_STATION") {
        const requestedConnectorId = decision?.connectorId;
        if (!requestedConnectorId) {
          throw new HttpError(
            400,
            "connectorId is required to accept station suggestion"
          );
        }
        const matched = stationSuggestion.connectors.find(
          (c) => c._id.toString() === requestedConnectorId
        );
        if (!matched) {
          throw new HttpError(
            409,
            "Selected connector is no longer available at the suggested station"
          );
        }
        const updated = await applyBookingUpdate(booking, {
          stationId: stationSuggestion.station._id,
          connectorId: matched._id,
        });
        const latestConnector = await Connector.findById(
          updated.connectorId
        ).lean();
        await notifyBookingChange(
          updated,
          `Moved to station ${stationSuggestion.station.name} (approx. ${stationSuggestion.distanceKm.toFixed(
            1
          )} km away).`
        );
        return {
          state: "station_reassigned",
          message: `Booking moved to station ${stationSuggestion.station.name}.`,
          booking: formatBookingDates(toPlain(updated)),
          context: {
            station: {
              ...buildStationPayload(stationSuggestion.station),
              distanceKm: Number(stationSuggestion.distanceKm.toFixed(2)),
            },
            connector: buildConnectorPayload(latestConnector || matched),
          },
        };
      }

      return {
        state: "station_suggestion",
        message:
          "Current station is fully occupied. Nearest station suggestion is available.",
        suggestion: {
          type: "station",
          station: {
            ...buildStationPayload(stationSuggestion.station),
            distanceKm: Number(stationSuggestion.distanceKm.toFixed(2)),
          },
          slotStart: stationSuggestion.slotStart,
          slotEnd: stationSuggestion.slotEnd,
          connectors: stationSuggestion.connectors.map(buildConnectorPayload),
        },
      };
    }
  }

  const slotSuggestion = await findNextSlotSuggestion(booking);
  if (slotSuggestion) {
    if (decisionType === "ACCEPT_SLOT") {
      const requestedConnectorId = decision?.connectorId;
      if (!requestedConnectorId) {
        throw new HttpError(
          400,
          "connectorId is required to accept slot suggestion"
        );
      }
      const matched = slotSuggestion.connectors.find(
        (c) => c._id.toString() === requestedConnectorId
      );
      if (!matched) {
        throw new HttpError(
          409,
          "Selected connector is no longer available for the suggested slot"
        );
      }
      const updated = await applyBookingUpdate(booking, {
        connectorId: matched._id,
        slotStart: slotSuggestion.slotStart,
        slotEnd: slotSuggestion.slotEnd,
      });
      const latestConnector = await Connector.findById(
        updated.connectorId
      ).lean();
      await notifyBookingChange(
        updated,
        `Rescheduled to a later slot starting at ${slotSuggestion.slotStart.toLocaleString()}.`
      );
      return {
        state: "slot_rescheduled",
        message: "Booking has been rescheduled to the next available slot.",
        booking: formatBookingDates(toPlain(updated)),
        context: {
          slotStart: slotSuggestion.slotStart,
          slotEnd: slotSuggestion.slotEnd,
          connector: buildConnectorPayload(latestConnector || matched),
        },
      };
    }

    if (decisionType === "REJECT_SLOT") {
      return {
        state: "unresolved",
        message:
          "Chưa thể xếp slot, vui lòng liên hệ nhân viên staff để hỗ trợ.",
      };
    }

    return {
      state: "slot_suggestion",
      message:
        "No nearby station available. Suggesting the next slot at the same station.",
      suggestion: {
        type: "slot",
        slotStart: slotSuggestion.slotStart,
        slotEnd: slotSuggestion.slotEnd,
        connectors: slotSuggestion.connectors.map(buildConnectorPayload),
      },
    };
  }

  return {
    state: "unresolved",
    message: "Chưa thể xếp slot, vui lòng liên hệ nhân viên staff để hỗ trợ.",
  };
};

module.exports = {
  resolveConflict,
};
