// src/controllers/stationsController.js
const Station = require("../models/Station");
const asyncHandler = require("../utils/asyncHandler");
const { HttpError } = require("../utils/errors");
const Charger = require("../models/Charger");
const Booking = require("../models/Booking");
const Tariff = require("../models/Tariff");
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
const { BOOKING_STATUS } = require("../constants/enums");
const { BOOKING_SLOT_MINUTES } = require("../constants/business");
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
 * List stations that have available connectors for a given time window
 * ==========================================================================*/
// exports.listAvailableStationsByTime = asyncHandler(async (req, res) => {
//   const {
//     startTime,
//     durationMinutes = BOOKING_SLOT_MINUTES,
//     connectorType,
//     stationId,
//     stationStatus,
//   } = req.query;

//   if (!startTime) {
//     throw new HttpError(400, "startTime is required");
//   }

//   const slotStart = new Date(startTime);
//   if (Number.isNaN(slotStart.getTime())) {
//     throw new HttpError(400, "Invalid startTime format");
//   }

//   const duration = Number(durationMinutes);
//   if (!Number.isFinite(duration) || duration <= 0) {
//     throw new HttpError(400, "durationMinutes must be a positive number");
//   }

//   const slotEnd = new Date(slotStart.getTime() + duration * 60000);

//   const { stationObjectId } = resolveStaffStationScope(req);

//   const connectorFilter = { status: { $ne: "OFFLINE" } };
//   if (stationObjectId) {
//     connectorFilter.stationId = stationObjectId;
//   } else if (stationId) {
//     connectorFilter.stationId = stationId;
//   }
//   if (connectorType) connectorFilter.type = connectorType;

//   const connectors = await Connector.find(connectorFilter)
//     .select("_id stationId chargerId type powerKw code status")
//     .lean();

//   if (connectors.length === 0) {
//     return res.json({
//       slot: {
//         start: slotStart.toISOString(),
//         end: slotEnd.toISOString(),
//         durationMinutes: duration,
//       },
//       stations: [],
//     });
//   }

//   const connectorIds = connectors.map((conn) => conn._id);

//   const overlappingBookings = await Booking.find({
//     connectorId: { $in: connectorIds },
//     status: { $in: [BOOKING_STATUS.RESERVED, BOOKING_STATUS.CHECKED_IN] },
//     slotStart: { $lt: slotEnd },
//     slotEnd: { $gt: slotStart },
//   })
//     .select("connectorId")
//     .lean();

//   const busyConnectorIds = new Set(
//     overlappingBookings
//       .map((bk) => bk.connectorId?.toString())
//       .filter(Boolean)
//   );

//   const availableConnectors = connectors.filter(
//     (conn) => conn.stationId && !busyConnectorIds.has(conn._id.toString())
//   );

//   if (availableConnectors.length === 0) {
//     return res.json({
//       slot: {
//         start: slotStart.toISOString(),
//         end: slotEnd.toISOString(),
//         durationMinutes: duration,
//       },
//       stations: [],
//     });
//   }

//   const uniqueStationIds = [
//     ...new Set(
//       availableConnectors
//         .map((conn) => conn.stationId?.toString())
//         .filter(Boolean)
//     ),
//   ];

//   const stationObjectIds = uniqueStationIds
//     .filter((id) => mongoose.Types.ObjectId.isValid(id))
//     .map((id) => new mongoose.Types.ObjectId(id));

//   if (stationObjectIds.length === 0) {
//     return res.json({
//       slot: {
//         start: slotStart.toISOString(),
//         end: slotEnd.toISOString(),
//         durationMinutes: duration,
//       },
//       stations: [],
//     });
//   }

//   const stationFilter = { _id: { $in: stationObjectIds } };
//   if (stationObjectId) {
//     stationFilter._id = stationObjectId;
//   }
//   if (stationStatus) stationFilter.status = stationStatus;

//   const stations = await Station.find(stationFilter)
//     .select("_id name lat lng status")
//     .lean();

//   if (stations.length === 0) {
//     return res.json({
//       slot: {
//         start: slotStart.toISOString(),
//         end: slotEnd.toISOString(),
//         durationMinutes: duration,
//       },
//       stations: [],
//     });
//   }

//   const allowedStationIds = new Set(stations.map((st) => st._id.toString()));

//   const connectorsByStation = new Map();
//   availableConnectors.forEach((conn) => {
//     const stationIdStr = conn.stationId.toString();
//     if (!allowedStationIds.has(stationIdStr)) return;
//     if (!connectorsByStation.has(stationIdStr)) {
//       connectorsByStation.set(stationIdStr, []);
//     }
//     connectorsByStation.get(stationIdStr).push(conn);
//   });

//   const tariffCache = new Map();
//   const tariffLookups = [];

//   connectorsByStation.forEach((connectorList, stationIdStr) => {
//     connectorList.forEach((conn) => {
//       const key = `${stationIdStr}_${conn.type}`;
//       if (tariffCache.has(key)) return;
//       tariffCache.set(key, null);
//       tariffLookups.push({ key, stationId: conn.stationId, connectorType: conn.type });
//     });
//   });

//   await Promise.all(
//     tariffLookups.map(async ({ key, stationId: stId, connectorType }) => {
//       const tariff = await Tariff.findEffectiveAt(stId, connectorType, slotStart);
//       tariffCache.set(key, tariff || null);
//     })
//   );

//   const stationMap = new Map(stations.map((st) => [st._id.toString(), st]));

//   const stationsPayload = [];

//   connectorsByStation.forEach((connectorList, stationIdStr) => {
//     const station = stationMap.get(stationIdStr);
//     if (!station) return;

//     const connectorsPayload = connectorList.map((conn) => {
//       const key = `${stationIdStr}_${conn.type}`;
//       const tariff = tariffCache.get(key);
//       const pricing = tariff
//         ? {
//             pricePerMin: tariff.pricePerMin,
//             pricePerKwh: tariff.pricePerKwh,
//             idleFeePerMin: tariff.idleFeePerMin,
//             currency: "VND",
//             mode: tariff.mode,
//           }
//         : null;

//       return {
//         id: conn._id,
//         code: conn.code,
//         type: conn.type,
//         powerKw: conn.powerKw,
//         pricing,
//       };
//     });

//     stationsPayload.push({
//       id: station._id,
//       name: station.name,
//       lat: station.lat,
//       lng: station.lng,
//       status: station.status,
//       availableConnectorCount: connectorsPayload.length,
//       availableConnectors: connectorsPayload,
//     });
//   });

//   res.json({
//     slot: {
//       start: slotStart.toISOString(),
//       end: slotEnd.toISOString(),
//       durationMinutes: duration,
//     },
//     stations: stationsPayload,
//   });
// });
exports.listAvailableStationsByTime = asyncHandler(async (req, res) => {
  const {
    startTime,
    durationMinutes = 30,
    connectorType,
    stationId,
    stationStatus,
    chargerId, // Thêm để lọc theo charger
  } = req.query;

  // Validate params
  if (!startTime) {
    throw new HttpError(
      400,
      "startTime is required (ISO string, e.g., 2025-11-22T10:00:00Z)"
    );
  }
  const start = new Date(startTime);
  if (Number.isNaN(start.getTime())) {
    throw new HttpError(400, "Invalid startTime format");
  }
  const duration = Number(durationMinutes);
  if (isNaN(duration) || duration <= 0) {
    throw new HttpError(400, "durationMinutes must be a positive number");
  }
  const endTime = new Date(start.getTime() + duration * 60 * 1000);

  // Build match for connectors
  const match = {
    status: { $ne: "OFFLINE" }, // Chỉ available connectors
  };
  if (stationId && mongoose.Types.ObjectId.isValid(stationId)) {
    match.stationId = new mongoose.Types.ObjectId(stationId);
  }
  if (connectorType) {
    match.type = connectorType;
  }
  if (chargerId && mongoose.Types.ObjectId.isValid(chargerId)) {
    match.chargerId = new mongoose.Types.ObjectId(chargerId); // Lọc đúng trụ
  }

  // Aggregation pipeline
  const pipeline = [
    { $match: match },
    // Lookup station để filter status
    {
      $lookup: {
        from: "stations",
        localField: "stationId",
        foreignField: "_id",
        as: "station",
      },
    },
    { $unwind: { path: "$station", preserveNullAndEmptyArrays: false } },
    // Filter station status
    ...(stationStatus ? [{ $match: { "station.status": stationStatus } }] : []),
    // Lookup bookings để check overlap
    {
      $lookup: {
        from: "bookings",
        let: { connectorId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$connectorId", "$$connectorId"] },
                  {
                    $in: [
                      "$status",
                      [BOOKING_STATUS.RESERVED, BOOKING_STATUS.CHECKED_IN],
                    ],
                  },
                  {
                    $or: [
                      {
                        $and: [
                          { $lt: ["$slotStart", endTime] },
                          { $gte: ["$slotStart", start] },
                        ],
                      },
                      {
                        $and: [
                          { $gt: ["$slotEnd", start] },
                          { $lte: ["$slotEnd", endTime] },
                        ],
                      },
                      {
                        $and: [
                          { $lte: ["$slotStart", start] },
                          { $gte: ["$slotEnd", endTime] },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
        ],
        as: "overlappingBookings",
      },
    },
    // Không lọc ra booked connectors, mà thêm flag isAvailable
    // { $match: { overlappingBookings: { $size: 0 } } }, // Remove this
    // Lookup charger
    {
      $lookup: {
        from: "chargers",
        localField: "chargerId",
        foreignField: "_id",
        as: "charger",
      },
    },
    { $unwind: { path: "$charger", preserveNullAndEmptyArrays: true } },
    // Project output với isAvailable
    {
      $project: {
        id: "$_id",
        code: 1,
        type: 1,
        powerKw: 1,
        status: 1,
        isAvailable: { $eq: [{ $size: "$overlappingBookings" }, 0] }, // Thêm flag
        charger: {
          id: "$charger._id",
          name: "$charger.name",
          code: "$charger.code",
        },
        station: {
          id: "$station._id",
          name: "$station.name",
          code: "$station.code",
          status: "$station.status",
        },
      },
    },
  ];

  const availableConnectors = await Connector.aggregate(pipeline);

  res.json({
    message: "Available connectors retrieved successfully",
    startTime: start.toISOString(),
    endTime: endTime.toISOString(),
    durationMinutes: duration,
    filters: { connectorType, stationId, stationStatus, chargerId },
    availableConnectors,
  });
});
/* ============================================================================
 * Delete station
 * ==========================================================================*/
exports.deleteStation = asyncHandler(async (req, res) => {
  const done = await Station.findByIdAndDelete(req.params.id);
  if (!done) throw new HttpError(404, "Station not found");
  res.json({ ok: true });
});
