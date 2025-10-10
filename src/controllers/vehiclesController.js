const mongoose = require("mongoose");
const Vehicle = require("../models/Vehicle");
const asyncHandler = require("../utils/asyncHandler");
const { HttpError } = require("../utils/errors");
const { ensureRequestUserId } = require("../utils/requestUser");
const { VEHICLE_PLUG_TYPES } = require("../constants/enums");

const sanitizePlugType = (plugType) => {
  if (typeof plugType !== "string") {
    return undefined;
  }
  const normalized = plugType.trim();
  return VEHICLE_PLUG_TYPES.includes(normalized) ? normalized : undefined;
};

const normalizeBatteryKwh = (value) => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const numeric = Number(value);
  if (Number.isNaN(numeric) || numeric <= 0) {
    return undefined;
  }
  return numeric;
};

const mapVehicleDoc = (vehicleDoc) => {
  if (!vehicleDoc) {
    return null;
  }
  const vehicle = vehicleDoc.toObject();
  return {
    id: vehicle.id,
    model: vehicle.model,
    plugType: vehicle.plugType,
    batteryKwh: vehicle.batteryKwh,
    userId: vehicle.userId,
    createdAt: vehicle.createdAt,
    updatedAt: vehicle.updatedAt,
  };
};

exports.createVehicle = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const { model } = req.body;
  const plugTypeInput = req.body.plugType ?? req.body.plug_type;
  const batteryInput = req.body.batteryKwh ?? req.body.battery_kwh;

  if (!model || typeof model !== "string" || !model.trim()) {
    throw new HttpError(400, "Vehicle model is required");
  }

  const normalizedPlugType = sanitizePlugType(plugTypeInput);
  if (!normalizedPlugType) {
    throw new HttpError(400, "Invalid or missing plugType");
  }

  const normalizedBattery = normalizeBatteryKwh(batteryInput);
  if (!normalizedBattery) {
    throw new HttpError(400, "batteryKwh must be a positive number");
  }

  const vehicle = await Vehicle.create({
    userId,
    model: model.trim(),
    plugType: normalizedPlugType,
    batteryKwh: normalizedBattery,
  });

  res.status(201).json({ vehicle: mapVehicleDoc(vehicle) });
});

exports.listMyVehicles = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const plugType = req.query.plugType ?? req.query.plug_type;

  const query = { userId };
  const normalizedPlugType = sanitizePlugType(plugType);
  if (plugType && normalizedPlugType) {
    query.plugType = normalizedPlugType;
  } else if (plugType && !normalizedPlugType) {
    return res.json({ vehicles: [] });
  }

  const vehicles = await Vehicle.find(query).sort({ createdAt: -1 }).lean();

  res.json({
    vehicles: vehicles.map((vehicle) => ({
      id: vehicle.id,
      model: vehicle.model,
      plugType: vehicle.plugType,
      batteryKwh: vehicle.batteryKwh,
      userId: vehicle.userId,
      createdAt: vehicle.createdAt,
      updatedAt: vehicle.updatedAt,
    })),
  });
});

const findUserVehicle = async (userId, vehicleIdOrObjectId) => {
  if (typeof vehicleIdOrObjectId === "string") {
    vehicleIdOrObjectId = vehicleIdOrObjectId.trim();
  }

  if (!vehicleIdOrObjectId) {
    return null;
  }

  const query = {
    userId,
    $or: [{ id: vehicleIdOrObjectId }],
  };

  if (mongoose.Types.ObjectId.isValid(vehicleIdOrObjectId)) {
    query.$or.push({ _id: vehicleIdOrObjectId });
  }

  return Vehicle.findOne(query);
};

exports.getVehicle = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const vehicle = await findUserVehicle(userId, req.params.id);

  if (!vehicle) {
    throw new HttpError(404, "Vehicle not found");
  }

  res.json({ vehicle: mapVehicleDoc(vehicle) });
});

exports.updateVehicle = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const vehicle = await findUserVehicle(userId, req.params.id);

  if (!vehicle) {
    throw new HttpError(404, "Vehicle not found");
  }

  const { model } = req.body;
  const plugTypeInput = req.body.plugType ?? req.body.plug_type;
  const batteryInput = req.body.batteryKwh ?? req.body.battery_kwh;

  if (model !== undefined) {
    if (!model || typeof model !== "string" || !model.trim()) {
      throw new HttpError(400, "model must be a non-empty string");
    }
    vehicle.model = model.trim();
  }

  if (plugTypeInput !== undefined) {
    const normalizedPlugType = sanitizePlugType(plugTypeInput);
    if (!normalizedPlugType) {
      throw new HttpError(400, "Invalid plugType");
    }
    vehicle.plugType = normalizedPlugType;
  }

  if (batteryInput !== undefined) {
    const normalizedBattery = normalizeBatteryKwh(batteryInput);
    if (!normalizedBattery) {
      throw new HttpError(400, "batteryKwh must be a positive number");
    }
    vehicle.batteryKwh = normalizedBattery;
  }

  await vehicle.save();

  res.json({ vehicle: mapVehicleDoc(vehicle) });
});

exports.deleteVehicle = asyncHandler(async (req, res) => {
  const userId = ensureRequestUserId(req);
  const vehicle = await findUserVehicle(userId, req.params.id);

  if (!vehicle) {
    throw new HttpError(404, "Vehicle not found");
  }

  await vehicle.deleteOne();

  res.json({ success: true });
});
