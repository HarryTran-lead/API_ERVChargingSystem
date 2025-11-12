// src/controllers/stationsController.js
const Station = require("../models/Station");
const asyncHandler = require("../utils/asyncHandler");
const { HttpError } = require("../utils/errors");
const Charger = require("../models/Charger");
const Connector = require("../models/Connector");
const Vehicle = require("../models/Vehicle");
const { ensureRequestUserId } = require("../utils/requestUser");
const {
  resolveStaffStationScope,
  assertStaffStationAccess,
} = require("../utils/stationScope");
const {
  getConnectorTypesForVehiclePlug,
} = require("../utils/connectorCompatibility");
const mongoose = require("mongoose");

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

/* ============================================================================
 * Create station
 * ==========================================================================*/
exports.createStation = asyncHandler(async (req, res) => {
  const { name, lat, lng, status } = req.body;
  if (typeof lat !== "number" || typeof lng !== "number") {
    throw new HttpError(400, "lat/lng must be numbers");
  }
  const station = await Station.create({
    name,
    lat,
    lng,
    status: status || "ONLINE",
    location: { type: "Point", coordinates: [lng, lat] },
  });
  res.status(201).json(station);
});

/* ============================================================================
 * List stations (supports near & staff scope)
 * ==========================================================================*/
exports.listStations = asyncHandler(async (req, res) => {
  const { stationObjectId } = resolveStaffStationScope(req);
  const { status, near, radiusKm = 5, page = 1, limit = 20 } = req.query;

  const filter = {};

  if (stationObjectId) {
    filter._id = stationObjectId;
  }

  if (status) filter.status = status;

  if (near) {
    // near = "lat,lng"
    const [lat, lng] = near.split(",").map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      filter.location = {
        $near: {
          $geometry: { type: "Point", coordinates: [lng, lat] },
          $maxDistance: Number(radiusKm) * 1000,
        },
      };
    }
  }

  const docs = await Station.find(filter)
    .skip((Number(page) - 1) * Number(limit))
    .limit(Number(limit))
    .lean();

  res.json(docs);
});

/* ============================================================================
 * Get a station
 * ==========================================================================*/
exports.getStation = asyncHandler(async (req, res) => {
  const st = await Station.findById(req.params.id).lean();
  if (!st) throw new HttpError(404, "Station not found");

  assertStaffStationAccess(req, st._id);
  res.json(st);
});

/* ============================================================================
 * Update station
 * ==========================================================================*/
exports.updateStation = asyncHandler(async (req, res) => {
  const { name, lat, lng, status } = req.body;
  const upd = {};
  if (name !== undefined) upd.name = name;
  if (lat !== undefined) upd.lat = lat;
  if (lng !== undefined) upd.lng = lng;
  if (status !== undefined) upd.status = status;
  if (lat !== undefined && lng !== undefined) {
    upd.location = { type: "Point", coordinates: [lng, lat] };
  }
  const st = await Station.findByIdAndUpdate(req.params.id, upd, { new: true });
  if (!st) throw new HttpError(404, "Station not found");
  res.json(st);
});

/* ============================================================================
 * List stations with assets (chargers + connectors) + pagination + scope
 * ==========================================================================*/
exports.listStationsWithAssets = asyncHandler(async (req, res) => {
  const { stationObjectId } = resolveStaffStationScope(req);
  const { status, page = 1, limit = 20, near, radiusKm = 5 } = req.query;

  const filter = {};

  if (stationObjectId) {
    filter._id = stationObjectId;
  }

  if (status) {
    filter.status = status;
  }

  // Near search
  if (near) {
    const [lat, lng] = near.split(",").map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      filter.location = {
        $near: {
          $geometry: { type: "Point", coordinates: [lng, lat] },
          $maxDistance: Number(radiusKm) * 1000,
        },
      };
    }
  }

  // Pagination
  const skip = (Number(page) - 1) * Number(limit);
  const stations = await Station.find(filter)
    .skip(skip)
    .limit(Number(limit))
    .lean();

  if (stations.length === 0) {
    return res.json({
      stations: [],
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total: 0,
        pages: 0,
      },
    });
  }

  const stationIds = stations.map((st) => st._id);

  // Chargers in these stations
  const chargers = await Charger.find({
    stationId: { $in: stationIds },
  }).lean();

  const chargerIds = chargers.map((charger) => charger._id);

  // Connectors in these chargers
  const connectors = chargerIds.length
    ? await Connector.find({ chargerId: { $in: chargerIds } }).lean()
    : [];

  // Group connectors by charger
  const connectorsByCharger = connectors.reduce((acc, connector) => {
    const chargerId = connector.chargerId?.toString();
    if (!chargerId) return acc;
    if (!acc[chargerId]) acc[chargerId] = [];
    acc[chargerId].push(connector);
    return acc;
  }, {});

  // Group chargers by station and attach connectors
  const chargersByStation = chargers.reduce((acc, charger) => {
    const stationId = charger.stationId?.toString();
    if (!stationId) return acc;
    if (!acc[stationId]) acc[stationId] = [];
    acc[stationId].push({
      ...charger,
      connectors: connectorsByCharger[charger._id.toString()] || [],
    });
    return acc;
  }, {});

  // Compose result
  const result = stations.map((station) => {
    const stationChargers = chargersByStation[station._id.toString()] || [];

    const totalConnectors = stationChargers.reduce(
      (sum, charger) => sum + charger.connectors.length,
      0
    );
    const availableConnectors = stationChargers.reduce(
      (sum, charger) =>
        sum +
        charger.connectors.filter((conn) => conn.status === "IDLE").length,
      0
    );

    return {
      ...station,
      chargers: stationChargers,
      summary: {
        totalChargers: stationChargers.length,
        totalConnectors: totalConnectors,
        availableConnectors: availableConnectors,
        occupiedConnectors: totalConnectors - availableConnectors,
      },
    };
  });

  // Count for pagination
  const totalStations = await Station.countDocuments(filter);
  const totalPages = Math.ceil(totalStations / Number(limit));

  res.json({
    stations: result,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total: totalStations,
      pages: totalPages,
    },
  });
});

/* ============================================================================
 * Get one station with assets
 * ==========================================================================*/
exports.getStationWithAssets = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!isValidObjectId(id)) {
    throw new HttpError(400, "Invalid station ID");
  }

  // Station
  const station = await Station.findById(id).lean();
  if (!station) {
    throw new HttpError(404, "Station not found");
  }

  assertStaffStationAccess(req, station._id);

  // Chargers of this station
  const chargers = await Charger.find({ stationId: id }).lean();

  if (chargers.length === 0) {
    return res.json({
      ...station,
      chargers: [],
    });
  }

  // Connectors for those chargers
  const chargerIds = chargers.map((charger) => charger._id);
  const connectors = await Connector.find({
    chargerId: { $in: chargerIds },
  }).lean();

  // Group connectors by charger
  const connectorsByCharger = connectors.reduce((acc, connector) => {
    const chargerId = connector.chargerId?.toString();
    if (!chargerId) return acc;
    if (!acc[chargerId]) acc[chargerId] = [];
    acc[chargerId].push(connector);
    return acc;
  }, {});

  // Attach connectors into chargers
  const chargersWithConnectors = chargers.map((charger) => ({
    ...charger,
    connectors: connectorsByCharger[charger._id.toString()] || [],
  }));

  res.json({
    ...station,
    chargers: chargersWithConnectors,
  });
});

/* ============================================================================
 * List compatible stations for a vehicle (respect staff scope)
 * ==========================================================================*/
exports.listCompatibleStationsForVehicle = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);

  const { vehicleId, connectorStatus, stationStatus } = req.query;

  const { stationObjectId } = resolveStaffStationScope(req);

  const vehicleFilter = {
    user_id: userId,
    deleted_at: null,
  };

  let selectedVehicle;

  if (vehicleId) {
    selectedVehicle = await Vehicle.findOne({
      ...vehicleFilter,
      id: vehicleId,
    }).lean();

    if (!selectedVehicle) {
      throw new HttpError(
        404,
        "VEHICLE_NOT_FOUND: The requested vehicle does not exist or belongs to another user."
      );
    }
  } else {
    selectedVehicle = await Vehicle.findOne({
      ...vehicleFilter,
      is_default: true,
    }).lean();

    if (!selectedVehicle) {
      throw new HttpError(
        409,
        "DEFAULT_VEHICLE_REQUIRED: Please register a vehicle and set it as default or specify vehicleId to fetch compatible stations."
      );
    }
  }

  const baseVehiclePayload = {
    id: selectedVehicle.id,
    plugType: selectedVehicle.plug_type,
    batteryKwh: selectedVehicle.battery_kwh,
    isDefault: selectedVehicle.is_default,
  };

  const connectorTypes = getConnectorTypesForVehiclePlug(
    selectedVehicle.plug_type
  );
  const sendResponse = (stationsPayload) =>
    res.json({
      vehicle: baseVehiclePayload,
      connectorTypes,
      stations: stationsPayload,
    });

  if (connectorTypes.length === 0) {
    return sendResponse([]);
  }

  const connectorFilter = { type: { $in: connectorTypes } };
  if (stationObjectId) connectorFilter.stationId = stationObjectId;
  if (connectorStatus) connectorFilter.status = connectorStatus;

  const connectors = await Connector.find(connectorFilter).lean();

  if (connectors.length === 0) {
    return sendResponse([]);
  }

  const stationIdStrings = connectors
    .map((conn) => (conn.stationId ? conn.stationId.toString() : null))
    .filter(Boolean);

  const uniqueStationIdStrings = [...new Set(stationIdStrings)];

  const stationObjectIds = uniqueStationIdStrings
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  if (stationObjectIds.length === 0) {
    return sendResponse([]);
  }

  const stationFilter = { _id: { $in: stationObjectIds } };
  if (stationObjectId) {
    stationFilter._id = stationObjectId;
  }
  if (stationStatus) stationFilter.status = stationStatus;

  const stations = await Station.find(stationFilter).lean();

  if (stations.length === 0) {
    return sendResponse([]);
  }

  const stationMap = new Map(stations.map((st) => [st._id.toString(), st]));
  const allowedStationIds = new Set(stations.map((st) => st._id.toString()));

  const filteredConnectors = connectors.filter(
    (conn) => conn.stationId && allowedStationIds.has(conn.stationId.toString())
  );

  if (filteredConnectors.length === 0) {
    return sendResponse([]);
  }

  const chargerIdStrings = filteredConnectors
    .map((conn) => (conn.chargerId ? conn.chargerId.toString() : null))
    .filter(Boolean);

  const uniqueChargerIdStrings = [...new Set(chargerIdStrings)];

  const chargerObjectIds = uniqueChargerIdStrings
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const chargers = chargerObjectIds.length
    ? await Charger.find({ _id: { $in: chargerObjectIds } }).lean()
    : [];

  if (chargers.length === 0) {
    return sendResponse([]);
  }

  const chargerMap = new Map(chargers.map((ch) => [ch._id.toString(), ch]));

  const stationsWithChargers = new Map();

  filteredConnectors.forEach((connector) => {
    const stationIdStr = connector.stationId.toString();
    const chargerIdStr = connector.chargerId
      ? connector.chargerId.toString()
      : null;
    if (!chargerIdStr) return;
    const chargerDoc = chargerMap.get(chargerIdStr);
    const stationDoc = stationMap.get(stationIdStr);
    if (!chargerDoc || !stationDoc) return;

    let stationEntry = stationsWithChargers.get(stationIdStr);
    if (!stationEntry) {
      stationEntry = {
        station: stationDoc,
        chargers: new Map(),
      };
      stationsWithChargers.set(stationIdStr, stationEntry);
    }

    let chargerEntry = stationEntry.chargers.get(chargerIdStr);
    if (!chargerEntry) {
      chargerEntry = {
        ...chargerDoc,
        connectors: [],
      };
      stationEntry.chargers.set(chargerIdStr, chargerEntry);
    }

    chargerEntry.connectors.push(connector);
  });

  if (stationsWithChargers.size === 0) {
    return sendResponse([]);
  }

  const stationsPayload = [];

  stationsWithChargers.forEach(({ station, chargers: chargerEntries }) => {
    const chargerList = Array.from(chargerEntries.values());
    const totalConnectors = chargerList.reduce(
      (sum, charger) => sum + charger.connectors.length,
      0
    );
    const availableConnectors = chargerList.reduce(
      (sum, charger) =>
        sum +
        charger.connectors.filter((conn) => conn.status === "IDLE").length,
      0
    );

    stationsPayload.push({
      ...station,
      chargers: chargerList,
      summary: {
        totalChargers: chargerList.length,
        totalConnectors,
        availableConnectors,
      },
    });
  });

  sendResponse(stationsPayload);
});

/* ============================================================================
 * Delete station
 * ==========================================================================*/
exports.deleteStation = asyncHandler(async (req, res) => {
  const done = await Station.findByIdAndDelete(req.params.id);
  if (!done) throw new HttpError(404, "Station not found");
  res.json({ ok: true });
});
