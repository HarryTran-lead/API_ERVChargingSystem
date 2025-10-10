const { completeSessionByReference } = require("./sessionFinalizer");

const PROJECT_WINDOW_MINUTES = 30;
const TICK_INTERVAL_MS = 1000;

const activeSessions = new Map();
const snapshotCache = new Map();

let ioInstance = null;

const parseNumber = (value, fallback = null) => {
  if (value === undefined || value === null) {
    return fallback;
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const roomName = (sessionId) => `session:${sessionId}`;

const computeProjectableEnergy = (
  { batteryKwh, connectorPowerKw, socTarget },
  socCurrent
) => {
  const normalizedBattery = parseNumber(batteryKwh);
  if (!normalizedBattery || normalizedBattery <= 0) {
    return null;
  }

  const normalizedTarget = parseNumber(socTarget, 100);
  const normalizedCurrent = parseNumber(socCurrent, 0);

  const remainingFraction = Math.max(
    0,
    (normalizedTarget - normalizedCurrent) / 100
  );
  const remainingCapacity = Math.max(0, normalizedBattery * remainingFraction);

  const normalizedPower = parseNumber(connectorPowerKw);
  const deliverableEnergy =
    normalizedPower && normalizedPower > 0
      ? normalizedPower * (PROJECT_WINDOW_MINUTES / 60)
      : null;

  const usableEnergy =
    deliverableEnergy !== null
      ? Math.min(remainingCapacity, deliverableEnergy)
      : remainingCapacity;

  return Number(Math.max(0, usableEnergy).toFixed(2));
};

const buildSnapshot = (entry, now = new Date()) => {
  const totalSeconds = Math.max(
    0,
    Math.round(parseNumber(entry.chargeDurationMinutes, 0) * 60)
  );
  const elapsedSeconds = Math.max(
    0,
    Math.floor((now.getTime() - entry.startedAt.getTime()) / 1000)
  );
  const remainingSeconds = Math.max(0, totalSeconds - elapsedSeconds);

  const socStart = parseNumber(entry.socStart, 0);
  const socTarget = parseNumber(entry.socTarget, 100);
  const progress =
    totalSeconds > 0 ? Math.min(1, elapsedSeconds / totalSeconds) : 1;

  const socCurrent = Number(
    (socStart + (socTarget - socStart) * progress).toFixed(1)
  );

  const snapshot = {
    sessionId: entry.sessionId,
    bookingId: entry.bookingId,
    connectorId: entry.connectorId,
    startedAt: entry.startedAt.toISOString(),
    chargeDurationMinutes: parseNumber(entry.chargeDurationMinutes, null),
    elapsedSeconds,
    remainingSeconds,
    socStart,
    socCurrent,
    socTarget,
    connectorPowerKw: parseNumber(entry.connectorPowerKw, null),
    batteryKwh: parseNumber(entry.batteryKwh, null),
    projectedEnergy30MinKwh: computeProjectableEnergy(entry, socCurrent),
    status: progress >= 1 ? "completed" : "charging",
    updatedAt: now.toISOString(),
  };

  if (entry.slotEnd) {
    snapshot.slotEnd = entry.slotEnd;
  }

  return snapshot;
};

const emitSnapshot = (snapshot) => {
  if (!snapshot?.sessionId) {
    return;
  }

  snapshotCache.set(snapshot.sessionId, snapshot);

  if (ioInstance) {
    ioInstance.emit("charging:update", snapshot);
  }

  if (process.env.NODE_ENV !== "test") {
    // eslint-disable-next-line no-console
    console.log("[charging-monitor]", snapshot.sessionId, snapshot);
  }
};

const cancelActiveInterval = (sessionId) => {
  if (!sessionId) {
    return null;
  }

  const key = sessionId.toString();
  const entry = activeSessions.get(key);
  if (entry?.interval) {
    clearInterval(entry.interval);
  }

  if (entry) {
    activeSessions.delete(key);
  }

  return entry || null;
};

const startSessionBroadcast = (sessionPayload, context = {}) => {
  const sessionId =
    sessionPayload?._id || sessionPayload?.id || sessionPayload?.sessionId;

  if (!sessionId) {
    return;
  }

  const startedAtRaw = sessionPayload.startedAt;
  const startedAt = startedAtRaw ? new Date(startedAtRaw) : null;
  if (!startedAt || Number.isNaN(startedAt.getTime())) {
    return;
  }

  let slotEndIso = null;
  if (sessionPayload.slotEnd) {
    const slotEndDate = new Date(sessionPayload.slotEnd);
    if (!Number.isNaN(slotEndDate.getTime())) {
      slotEndIso = slotEndDate.toISOString();
    }
  }

  const entry = {
    sessionId: sessionId.toString(),
    bookingId: sessionPayload.bookingId || context.bookingId || null,
    connectorId: sessionPayload.connectorId || context.connectorId || null,
    startedAt,
    chargeDurationMinutes:
      parseNumber(sessionPayload.chargeDurationMinutes, null) ??
      parseNumber(context.chargeDurationMinutes, null) ??
      0,
    socStart: parseNumber(sessionPayload.socStart, 0),
    socTarget: parseNumber(sessionPayload.socTarget, 100),
    connectorPowerKw: parseNumber(context.connectorPowerKw, null),
    batteryKwh: parseNumber(context.batteryKwh, null),
    slotEnd: slotEndIso,
  };

  cancelActiveInterval(entry.sessionId);

  const initialSnapshot = buildSnapshot(entry);
  emitSnapshot(initialSnapshot);

  const interval = setInterval(() => {
    const nextSnapshot = buildSnapshot(entry);
    emitSnapshot(nextSnapshot);

    if (nextSnapshot.status === "completed") {
      cancelActiveInterval(entry.sessionId);
      const expectedStop = (() => {
        if (
          entry.startedAt instanceof Date &&
          !Number.isNaN(entry.startedAt.getTime()) &&
          entry.chargeDurationMinutes
        ) {
          return new Date(
            entry.startedAt.getTime() +
              Math.round(entry.chargeDurationMinutes * 60 * 1000)
          );
        }
        return new Date();
      })();

      completeSessionByReference(entry.sessionId, {
        stoppedAt: expectedStop,
      })
        .then((sessionDoc) => {
          if (!sessionDoc) {
            return;
          }

          const payload =
            typeof sessionDoc.toObject === "function"
              ? sessionDoc.toObject()
              : sessionDoc;

          finalizeSessionBroadcast(payload, {
            elapsedSeconds: nextSnapshot.elapsedSeconds,
            socCurrent: nextSnapshot.socCurrent,
            status: "COMPLETED",
          });
        })
        .catch((err) => {
          if (process.env.NODE_ENV !== "test") {
            // eslint-disable-next-line no-console
            console.error(
              "[charging-monitor] Failed to auto-complete session",
              entry.sessionId,
              err
            );
          }
        });
    }
  }, TICK_INTERVAL_MS);

  entry.interval = interval;
  activeSessions.set(entry.sessionId, entry);
};

const finalizeSessionBroadcast = (sessionPayload, overrides = {}) => {
  const sessionId =
    sessionPayload?._id || sessionPayload?.id || sessionPayload?.sessionId;

  if (!sessionId) {
    return null;
  }

  const key = sessionId.toString();
  const entry = cancelActiveInterval(key);
  const cached = snapshotCache.get(key) || {};

  const nowRaw = sessionPayload?.stoppedAt || overrides.endedAt;
  const now = nowRaw ? new Date(nowRaw) : new Date();

  const socStart =
    parseNumber(sessionPayload?.socStart) ??
    parseNumber(cached.socStart) ??
    parseNumber(entry?.socStart, 0);

  const socTarget =
    parseNumber(sessionPayload?.socTarget) ??
    parseNumber(cached.socTarget) ??
    parseNumber(entry?.socTarget, 100);

  const socEnd =
    parseNumber(sessionPayload?.socEnd) ??
    parseNumber(overrides.socCurrent) ??
    parseNumber(cached.socCurrent) ??
    socTarget;

  const resolvedSocEnd = parseNumber(socEnd, socTarget);
  const normalizedSocEnd =
    resolvedSocEnd !== null && resolvedSocEnd !== undefined
      ? Number(resolvedSocEnd)
      : null;
  const socCurrentValue =
    normalizedSocEnd !== null && Number.isFinite(normalizedSocEnd)
      ? Number(normalizedSocEnd.toFixed(1))
      : null;

  const chargeDurationMinutes =
    parseNumber(sessionPayload?.chargeDurationMinutes) ??
    parseNumber(cached.chargeDurationMinutes) ??
    parseNumber(entry?.chargeDurationMinutes, null);

  const elapsedSeconds = (() => {
    if (overrides.elapsedSeconds !== undefined) {
      return overrides.elapsedSeconds;
    }

    if (sessionPayload?.totalChargingMinutes !== undefined) {
      return Math.round(Number(sessionPayload.totalChargingMinutes) * 60);
    }

    if (cached.elapsedSeconds !== undefined) {
      return cached.elapsedSeconds;
    }

    if (entry?.startedAt) {
      return Math.max(
        0,
        Math.floor((now.getTime() - entry.startedAt.getTime()) / 1000)
      );
    }

    return 0;
  })();

  const batteryKwh =
    parseNumber(overrides.batteryKwh) ??
    parseNumber(sessionPayload?.batteryKwh) ??
    parseNumber(cached.batteryKwh) ??
    parseNumber(entry?.batteryKwh, null);

  const connectorPowerKw =
    parseNumber(overrides.connectorPowerKw) ??
    parseNumber(cached.connectorPowerKw) ??
    parseNumber(entry?.connectorPowerKw, null);

  const finalSnapshot = {
    sessionId: key,
    bookingId:
      sessionPayload?.bookingId || cached.bookingId || entry?.bookingId || null,
    connectorId:
      sessionPayload?.connectorId ||
      cached.connectorId ||
      entry?.connectorId ||
      null,
    startedAt:
      sessionPayload?.startedAt ||
      cached.startedAt ||
      entry?.startedAt?.toISOString() ||
      null,
    chargeDurationMinutes,
    elapsedSeconds,
    remainingSeconds: 0,
    socStart,
    socCurrent: socCurrentValue ?? socTarget ?? null,
    socTarget,
    connectorPowerKw,
    batteryKwh,
    projectedEnergy30MinKwh: computeProjectableEnergy(
      { batteryKwh, connectorPowerKw, socTarget },
      socCurrentValue ?? socTarget
    ),
    status:
      overrides.status ||
      (sessionPayload?.status === "COMPLETED" ? "completed" : "stopped"),
    totalChargingMinutes:
      sessionPayload?.totalChargingMinutes ??
      cached.totalChargingMinutes ??
      (elapsedSeconds ? elapsedSeconds / 60 : null),
    totalIdleMinutes:
      sessionPayload?.totalIdleMinutes ??
      cached.totalIdleMinutes ??
      overrides.totalIdleMinutes ??
      0,
    endedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  let finalSlotEnd = null;
  if (sessionPayload?.slotEnd) {
    const slotEndDate = new Date(sessionPayload.slotEnd);
    if (!Number.isNaN(slotEndDate.getTime())) {
      finalSlotEnd = slotEndDate.toISOString();
    }
  } else if (cached.slotEnd) {
    finalSlotEnd = cached.slotEnd;
  }

  if (finalSlotEnd) {
    finalSnapshot.slotEnd = finalSlotEnd;
  }

  snapshotCache.set(key, finalSnapshot);
  emitSnapshot(finalSnapshot);

  return finalSnapshot;
};

const getSnapshot = (sessionId) => {
  if (!sessionId) {
    return null;
  }

  return snapshotCache.get(sessionId.toString()) || null;
};

const attachIoServer = (io) => {
  ioInstance = io;
};

module.exports = {
  attachIoServer,
  startSessionBroadcast,
  finalizeSessionBroadcast,
  getSnapshot,
  roomName,
};
