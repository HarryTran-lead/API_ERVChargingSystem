const Station = require("../models/Station");
const asyncHandler = require("../utils/asyncHandler");
const { HttpError } = require("../utils/errors");
const Charger = require("../models/Charger");
const Connector = require("../models/Connector");
const Vehicle = require("../models/Vehicle");
const { ensureRequestUserId } = require("../utils/requestUser");
const {
  getConnectorTypesForVehiclePlug,
} = require("../utils/connectorCompatibility");
const mongoose = require("mongoose");

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);
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

exports.listStations = asyncHandler(async (req, res) => {
  const { status, near, radiusKm = 5, page = 1, limit = 20 } = req.query;
  const q = {};
  if (status) q.status = status;

  let query = Station.find(q);
  if (near) {
    // near = "lat,lng"
    const [lat, lng] = near.split(",").map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      query = Station.find({
        location: {
          $near: {
            $geometry: { type: "Point", coordinates: [lng, lat] },
            $maxDistance: Number(radiusKm) * 1000,
          },
        },
      });
    }
  }

  const docs = await query
    .skip((Number(page) - 1) * Number(limit))
    .limit(Number(limit))
    .lean();

  res.json(docs);
});

exports.getStation = asyncHandler(async (req, res) => {
  const st = await Station.findById(req.params.id).lean();
  if (!st) throw new HttpError(404, "Station not found");
  res.json(st);
});

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

exports.listStationsWithAssets = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 20, near, radiusKm = 5 } = req.query;

  const filter = {};

  if (status) {
    filter.status = status;
  }

  let query = Station.find(filter);

  // Hỗ trợ tìm kiếm theo vị trí gần
  if (near) {
    const [lat, lng] = near.split(",").map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      query = Station.find({
        location: {
          $near: {
            $geometry: { type: "Point", coordinates: [lng, lat] },
            $maxDistance: Number(radiusKm) * 1000,
          },
        },
      });
    }
  }

  // Pagination
  const skip = (Number(page) - 1) * Number(limit);
  const stations = await query.skip(skip).limit(Number(limit)).lean();

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

  // Lấy tất cả charger thuộc các trạm này
  const chargers = await Charger.find({
    stationId: { $in: stationIds },
  }).lean();

  const chargerIds = chargers.map((charger) => charger._id);

  // Lấy tất cả connector thuộc các charger này
  const connectors = chargerIds.length
    ? await Connector.find({ chargerId: { $in: chargerIds } }).lean()
    : [];

  // Nhóm connector theo charger
  const connectorsByCharger = connectors.reduce((acc, connector) => {
    const chargerId = connector.chargerId?.toString();
    if (!chargerId) return acc;
    if (!acc[chargerId]) acc[chargerId] = [];
    acc[chargerId].push(connector);
    return acc;
  }, {});

  // Nhóm charger theo station và gắn connector
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

  // Tạo kết quả với thông tin chi tiết
  const result = stations.map((station) => {
    const stationChargers = chargersByStation[station._id.toString()] || [];

    // Tính tổng số connector và trạng thái
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

  // Đếm tổng số trạm cho pagination
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

exports.getStationWithAssets = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!isValidObjectId(id)) {
    throw new HttpError(400, "Invalid station ID");
  }

  // Lấy thông tin trạm
  const station = await Station.findById(id).lean();
  if (!station) {
    throw new HttpError(404, "Station not found");
  }

  // Lấy tất cả charger thuộc trạm này
  const chargers = await Charger.find({ stationId: id }).lean();

  if (chargers.length === 0) {
    return res.json({
      ...station,
      chargers: [],
    });
  }

  // Lấy tất cả connector thuộc các charger này
  const chargerIds = chargers.map((charger) => charger._id);
  const connectors = await Connector.find({
    chargerId: { $in: chargerIds },
  }).lean();

  // Nhóm connector theo charger
  const connectorsByCharger = connectors.reduce((acc, connector) => {
    const chargerId = connector.chargerId?.toString();
    if (!chargerId) return acc;
    if (!acc[chargerId]) acc[chargerId] = [];
    acc[chargerId].push(connector);
    return acc;
  }, {});

  // Gắn connector vào từng charger
  const chargersWithConnectors = chargers.map((charger) => ({
    ...charger,
    connectors: connectorsByCharger[charger._id.toString()] || [],
  }));

  // Trả về kết quả
  res.json({
    ...station,
    chargers: chargersWithConnectors,
  });
});

exports.listCompatibleStationsForVehicle = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);

  const defaultVehicle = await Vehicle.findOne({
    user_id: userId,
    deleted_at: null,
    is_default: true,
  }).lean();

  if (!defaultVehicle) {
    throw new HttpError(
      409,
      "DEFAULT_VEHICLE_REQUIRED: Please register a vehicle and set it as default to fetch compatible stations."
    );
  }

  const baseVehiclePayload = {
    id: defaultVehicle.id,
    plugType: defaultVehicle.plug_type,
    batteryKwh: defaultVehicle.battery_kwh,
    isDefault: defaultVehicle.is_default,
  };

  const connectorTypes = getConnectorTypesForVehiclePlug(
    defaultVehicle.plug_type
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

  const { connectorStatus, stationStatus } = req.query;

  const connectorFilter = { type: { $in: connectorTypes } };
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

exports.deleteStation = asyncHandler(async (req, res) => {
  const done = await Station.findByIdAndDelete(req.params.id);
  if (!done) throw new HttpError(404, "Station not found");
  res.json({ ok: true });
});
