// src/controllers/vehicleController.js
const mongoose = require("mongoose");
const Vehicle = require("../models/Vehicle");
const { ensureRequestUserId } = require("../utils/requestUser");
const { formatVehicleDates } = require("../utils/timezoneHelpers");

// Map lỗi duplicate index → thông báo dễ hiểu
function parseDup(err) {
  if (err?.code === 11000) {
    if (err.keyPattern?.license_plate_norm) {
      return {
        status: 409,
        body: {
          error: "DUPLICATE_LICENSE_PLATE",
          message: "Biển số đã tồn tại cho user này.",
        },
      };
    }
    return {
      status: 409,
      body: { error: "DUPLICATE_KEY", message: "Dữ liệu trùng lặp." },
    };
  }
  return null;
}

// POST /api/v1/vehicles
exports.create = async (req, res) => {
  try {
    const userId = ensureRequestUserId(req);
    const {
      licensePlate,
      make,
      model,
      year,
      color,
      plugType,
      batteryKwh,
      isDefault,
    } = req.body;

    const v = await Vehicle.create({
      user_id: userId,
      license_plate: licensePlate,
      make,
      model,
      year,
      color,
      plug_type: plugType,
      battery_kwh: batteryKwh,
      is_default: !!isDefault, // pre('save') sẽ unset default cũ nếu cần
    });

    return res.status(201).json({ data: formatVehicleDates(v) });
  } catch (err) {
    const dup = parseDup(err);
    if (dup) return res.status(dup.status).json(dup.body);
    return res
      .status(400)
      .json({ error: "CREATE_VEHICLE_FAILED", detail: err.message });
  }
};

// GET /api/v1/vehicles/mine
exports.listMine = async (req, res) => {
  try {
    const userId = ensureRequestUserId(req);
    const list = await Vehicle.find({ user_id: userId, deleted_at: null })
      .sort({ is_default: -1, created_at: -1 })
      .lean();
    const formattedList = list.map((vehicle) => formatVehicleDates(vehicle));
    return res.json({ data: formattedList });
  } catch (err) {
    return res
      .status(500)
      .json({ error: "LIST_VEHICLES_FAILED", detail: err.message });
  }
};

// GET /api/v1/vehicles/:vehicleId
exports.getOne = async (req, res) => {
  try {
    const userId = ensureRequestUserId(req);
    const { vehicleId } = req.params;

    const or = [{ id: vehicleId }];
    if (mongoose.Types.ObjectId.isValid(vehicleId)) {
      or.push({ _id: vehicleId });
    }

    const v = await Vehicle.findOne({
      user_id: userId,
      deleted_at: null,
      $or: or,
    });

    if (!v) return res.status(404).json({ error: "VEHICLE_NOT_FOUND" });
    return res.json({ data: formatVehicleDates(v) });
  } catch (err) {
    return res
      .status(500)
      .json({ error: "GET_VEHICLE_FAILED", detail: err.message });
  }
};

// PUT /api/v1/vehicles/:vehicleId
exports.update = async (req, res) => {
  try {
    const userId = ensureRequestUserId(req);
    const { vehicleId } = req.params;

    // Cho phép id hoặc _id
    const findOr = [{ id: vehicleId }];
    if (mongoose.Types.ObjectId.isValid(vehicleId)) {
      findOr.push({ _id: vehicleId });
    }

    const v = await Vehicle.findOne({
      user_id: userId,
      deleted_at: null,
      $or: findOr,
    });
    if (!v) return res.status(404).json({ error: "VEHICLE_NOT_FOUND" });

    const {
      licensePlate,
      make,
      model,
      year,
      color,
      plugType,
      batteryKwh,
      isDefault,
    } = req.body;

    if (licensePlate != null) v.license_plate = licensePlate;
    if (make != null) v.make = make;
    if (model != null) v.model = model;
    if (year != null) v.year = year;
    if (color != null) v.color = color;
    if (plugType != null) v.plug_type = plugType;
    if (batteryKwh != null) v.battery_kwh = batteryKwh;
    if (isDefault != null) v.is_default = !!isDefault; // pre('save') sẽ unset default cũ

    await v.save(); // chạy validate + pre-save (unset default cũ nếu cần)
    return res.json({ data: formatVehicleDates(v) });
  } catch (err) {
    const dup = parseDup(err);
    if (dup) return res.status(dup.status).json(dup.body);
    return res
      .status(400)
      .json({ error: "UPDATE_VEHICLE_FAILED", detail: err.message });
  }
};

// POST /api/v1/vehicles/:vehicleId/default
exports.setDefault = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const userId = ensureRequestUserId(req);
    const { vehicleId } = req.params;

    const or = [{ id: vehicleId }];
    if (mongoose.Types.ObjectId.isValid(vehicleId)) {
      or.push({ _id: vehicleId });
    }

    const v = await Vehicle.findOne({
      user_id: userId,
      deleted_at: null,
      $or: or,
    }).session(session);

    if (!v) {
      await session.abortTransaction();
      return res.status(404).json({ error: "VEHICLE_NOT_FOUND" });
    }

    await Vehicle.updateMany(
      { user_id: userId, deleted_at: null, _id: { $ne: v._id } },
      { $set: { is_default: false } },
      { session }
    );

    v.is_default = true;
    await v.save({ session });

    await session.commitTransaction();
    return res.json({ data: formatVehicleDates(v) });
  } catch (err) {
    await session.abortTransaction();
    return res
      .status(400)
      .json({ error: "SET_DEFAULT_FAILED", detail: err.message });
  } finally {
    session.endSession();
  }
};

// DELETE /api/v1/vehicles/:vehicleId
exports.remove = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const userId = ensureRequestUserId(req);
    const { vehicleId } = req.params;

    const or = [{ id: vehicleId }];
    if (mongoose.Types.ObjectId.isValid(vehicleId)) {
      or.push({ _id: vehicleId });
    }

    const v = await Vehicle.findOne({
      user_id: userId,
      deleted_at: null,
      $or: or,
    }).session(session);

    if (!v) {
      await session.abortTransaction();
      return res.status(404).json({ error: "VEHICLE_NOT_FOUND" });
    }

    const wasDefault = v.is_default === true;

    v.deleted_at = new Date();
    v.is_default = false; // tránh vi phạm unique partial index
    await v.save({ session });

    if (wasDefault) {
      // Gán default cho xe còn lại (mới nhất)
      const other = await Vehicle.findOne({
        user_id: userId,
        deleted_at: null,
      })
        .sort({ created_at: -1 })
        .session(session);

      if (other) {
        other.is_default = true;
        await other.save({ session });
      }
    }

    await session.commitTransaction();
    return res.json({ data: { id: v.id, deleted_at: v.deleted_at } });
  } catch (err) {
    await session.abortTransaction();
    return res
      .status(400)
      .json({ error: "DELETE_VEHICLE_FAILED", detail: err.message });
  } finally {
    session.endSession();
  }
};
