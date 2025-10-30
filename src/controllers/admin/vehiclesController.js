const mongoose = require('mongoose');
const Vehicle = require('../../models/Vehicle');
const asyncHandler = require('../../utils/asyncHandler');
const { HttpError } = require('../../utils/errors');
const { formatVehicleDates } = require('../../utils/timezoneHelpers');

const toPlain = (doc) =>
  doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;

const parseBoolean = (value) => {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return undefined;
};

const buildVehicleQuery = (params = {}) => {
  const query = {};
  if (params.userId) {
    query.user_id = params.userId;
  }
  const deleted = parseBoolean(params.deleted);
  if (deleted === false) {
    query.deleted_at = null;
  } else if (deleted === true) {
    query.deleted_at = { $ne: null };
  }
  if (params.plate) {
    const escaped = params.plate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    query.license_plate = { $regex: regex };
  }
  if (params.plugType) {
    query.plug_type = params.plugType;
  }
  return query;
};

const formatVehicle = (vehicleDoc) => {
  if (!vehicleDoc) return null;
  return formatVehicleDates(toPlain(vehicleDoc));
};

const findVehicleByParam = async (param, session = null) => {
  const or = [{ id: param }];
  if (mongoose.Types.ObjectId.isValid(param)) {
    or.push({ _id: new mongoose.Types.ObjectId(param) });
  }
  const query = Vehicle.findOne({ $or: or });
  if (session) {
    query.session(session);
  }
  return query;
};

exports.listVehicles = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, sort = '-created_at' } = req.query;
  const pageNumber = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 20));
  const skip = (pageNumber - 1) * pageSize;

  const sortSpec = {};
  const sortFields = String(sort)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (sortFields.length === 0) {
    sortSpec.created_at = -1;
  } else {
    sortFields.forEach((field) => {
      let direction = 1;
      let name = field;
      if (field.startsWith('-')) {
        direction = -1;
        name = field.slice(1);
      } else if (field.startsWith('+')) {
        name = field.slice(1);
      }
      if (['created_at', 'updated_at', 'license_plate'].includes(name)) {
        sortSpec[name] = direction;
      }
    });
    if (Object.keys(sortSpec).length === 0) {
      sortSpec.created_at = -1;
    }
  }

  const query = buildVehicleQuery(req.query);
  const [items, total] = await Promise.all([
    Vehicle.find(query)
      .sort(sortSpec)
      .skip(skip)
      .limit(pageSize)
      .lean(),
    Vehicle.countDocuments(query),
  ]);

  res.json({
    pagination: {
      page: pageNumber,
      limit: pageSize,
      total,
      pages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
    },
    items: items.map((vehicle) => formatVehicle(vehicle)),
  });
});

exports.getVehicle = asyncHandler(async (req, res) => {
  const vehicle = await findVehicleByParam(req.params.id);
  if (!vehicle) {
    throw new HttpError(404, 'Vehicle not found');
  }
  res.json({ vehicle: formatVehicle(vehicle) });
});

exports.updateVehicle = asyncHandler(async (req, res) => {
  const vehicle = await findVehicleByParam(req.params.id);
  if (!vehicle) {
    throw new HttpError(404, 'Vehicle not found');
  }

  const {
    licensePlate,
    make,
    model,
    year,
    color,
    plugType,
    batteryKwh,
    isDefault,
    deleted,
  } = req.body;

  if (licensePlate != null) vehicle.license_plate = licensePlate;
  if (make != null) vehicle.make = make;
  if (model != null) vehicle.model = model;
  if (year != null) vehicle.year = year;
  if (color != null) vehicle.color = color;
  if (plugType != null) vehicle.plug_type = plugType;
  if (batteryKwh != null) vehicle.battery_kwh = batteryKwh;
  if (isDefault != null) vehicle.is_default = !!isDefault;

  const deletedFlag = parseBoolean(deleted);
  if (deletedFlag === true) {
    vehicle.deleted_at = vehicle.deleted_at || new Date();
    vehicle.is_default = false;
  } else if (deletedFlag === false) {
    vehicle.deleted_at = null;
  }

  await vehicle.save();

  res.json({ vehicle: formatVehicle(vehicle) });
});

exports.deleteVehicle = asyncHandler(async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const vehicle = await findVehicleByParam(req.params.id, session);
    if (!vehicle) {
      throw new HttpError(404, 'Vehicle not found');
    }

    if (!vehicle.deleted_at) {
      vehicle.deleted_at = new Date();
    }
    const wasDefault = vehicle.is_default === true;
    vehicle.is_default = false;
    await vehicle.save({ session });

    if (wasDefault) {
      const replacement = await Vehicle.findOne({
        user_id: vehicle.user_id,
        deleted_at: null,
        _id: { $ne: vehicle._id },
      })
        .sort({ created_at: -1 })
        .session(session);

      if (replacement) {
        replacement.is_default = true;
        await replacement.save({ session });
      }
    }

    await session.commitTransaction();
    res.json({ vehicle: formatVehicle(vehicle) });
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
});

exports.restoreVehicle = asyncHandler(async (req, res) => {
  const vehicle = await findVehicleByParam(req.params.id);
  if (!vehicle) {
    throw new HttpError(404, 'Vehicle not found');
  }

  if (!vehicle.deleted_at) {
    return res.json({ vehicle: formatVehicle(vehicle) });
  }

  vehicle.deleted_at = null;
  await vehicle.save();
  res.json({ vehicle: formatVehicle(vehicle) });
});