const mongoose = require("mongoose");

const { HttpError } = require("./errors");
const { ensureRequestUser } = require("./requestUser");
const { ROLES } = require("../constants/enums");

const resolveStaffStationScope = (req) => {
  const actor = ensureRequestUser(req);

  if (actor.role !== ROLES.STAFF) {
    return { actor, stationId: null, stationObjectId: null };
  }

  const assignedStation = actor.stationId;

  if (!assignedStation) {
    throw new HttpError(403, "Staff is not assigned to any station");
  }

  if (!mongoose.Types.ObjectId.isValid(assignedStation)) {
    throw new HttpError(403, "Assigned station is invalid");
  }

  const stationObjectId = new mongoose.Types.ObjectId(assignedStation);

  return {
    actor,
    stationId: stationObjectId.toString(),
    stationObjectId,
  };
};

const assertStaffStationAccess = (req, stationId) => {
  const { stationObjectId } = resolveStaffStationScope(req);

  if (!stationObjectId) return;

  if (!stationId) {
    throw new HttpError(404, "Station not found");
  }

  const normalized =
    typeof stationId === "string"
      ? stationId
      : typeof stationId?.toString === "function"
        ? stationId.toString()
        : null;

  if (!normalized || normalized !== stationObjectId.toString()) {
    throw new HttpError(403, "Forbidden: station mismatch");
  }
};

module.exports = {
  resolveStaffStationScope,
  assertStaffStationAccess,
};