// src/controllers/vehicleController.js
const mongoose = require('mongoose');
const Vehicle = require('../models/Vehicle');

// Map lỗi duplicate index → thông báo dễ hiểu
function parseDup(err) {
  if (err?.code === 11000) {
    if (err.keyPattern?.license_plate_norm) {
      return { status: 409, body: { error: 'DUPLICATE_LICENSE_PLATE', message: 'Biển số đã tồn tại cho user này.' } };
    }
    return { status: 409, body: { error: 'DUPLICATE_KEY', message: 'Dữ liệu trùng lặp.' } };
  }
  return null;
}

// Tạo xe mới
exports.create = async (req, res) => {
  try {
    const userId = req.user.id; // JWT middleware gắn vào
    const {
      licensePlate, make, model, year, color,
      plugType, batteryKwh, isDefault
    } = req.body;

    const v = await Vehicle.create({
      user_id: userId,
      license_plate: licensePlate,
      make, model, year, color,
      plug_type: plugType,
      battery_kwh: batteryKwh,
      is_default: !!isDefault
    });

    return res.status(201).json({ data: v });
  } catch (err) {
    const dup = parseDup(err);
    if (dup) return res.status(dup.status).json(dup.body);
    return res.status(400).json({ error: 'CREATE_VEHICLE_FAILED', detail: err.message });
  }
};

// Danh sách xe của tôi
exports.listMine = async (req, res) => {
  try {
    const userId = req.user.id;
    const list = await Vehicle.find({ user_id: userId, deleted_at: null })
      .sort({ is_default: -1, created_at: -1 })
      .lean();
    return res.json({ data: list });
  } catch (err) {
    return res.status(500).json({ error: 'LIST_VEHICLES_FAILED', detail: err.message });
  }
};

// Lấy chi tiết 1 xe theo id (UUID)
exports.getOne = async (req, res) => {
  try {
    const userId = req.user.id;
    const { vehicleId } = req.params;
    const v = await Vehicle.findOne({ id: vehicleId, user_id: userId, deleted_at: null });
    if (!v) return res.status(404).json({ error: 'VEHICLE_NOT_FOUND' });
    return res.json({ data: v });
  } catch (err) {
    return res.status(500).json({ error: 'GET_VEHICLE_FAILED', detail: err.message });
  }
};

// Cập nhật xe (có thể đổi biển số, plugType..., và cả is_default)
exports.update = async (req, res) => {
  try {
    const userId = req.user.id;
    const { vehicleId } = req.params;
    const v = await Vehicle.findOne({ id: vehicleId, user_id: userId, deleted_at: null });
    if (!v) return res.status(404).json({ error: 'VEHICLE_NOT_FOUND' });

    const {
      licensePlate, make, model, year, color,
      plugType, batteryKwh, isDefault
    } = req.body;

    if (licensePlate != null) v.license_plate = licensePlate;
    if (make != null) v.make = make;
    if (model != null) v.model = model;
    if (year != null) v.year = year;
    if (color != null) v.color = color;
    if (plugType != null) v.plug_type = plugType;
    if (batteryKwh != null) v.battery_kwh = batteryKwh;
    if (isDefault != null) v.is_default = !!isDefault; // pre('save') sẽ unset default cũ

    await v.save(); // chạy hook validate + pre-save (unset default cũ)
    return res.json({ data: v });
  } catch (err) {
    const dup = parseDup(err);
    if (dup) return res.status(dup.status).json(dup.body);
    return res.status(400).json({ error: 'UPDATE_VEHICLE_FAILED', detail: err.message });
  }
};

// Đặt xe mặc định (an toàn cho case findOneAndUpdate không chạy pre-save)
exports.setDefault = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const userId = req.user.id;
    const { vehicleId } = req.params;

    const v = await Vehicle.findOne({ id: vehicleId, user_id: userId, deleted_at: null }).session(session);
    if (!v) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'VEHICLE_NOT_FOUND' });
    }

    await Vehicle.updateMany(
      { user_id: userId, deleted_at: null, _id: { $ne: v._id } },
      { $set: { is_default: false } },
      { session }
    );
    v.is_default = true;
    await v.save({ session });

    await session.commitTransaction();
    return res.json({ data: v });
  } catch (err) {
    await session.abortTransaction();
    return res.status(400).json({ error: 'SET_DEFAULT_FAILED', detail: err.message });
  } finally {
    session.endSession();
  }
};

// Xoá mềm (nếu đang default → chuyển default cho xe khác nếu có)
exports.remove = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const userId = req.user.id;
    const { vehicleId } = req.params;

    const v = await Vehicle.findOne({ id: vehicleId, user_id: userId, deleted_at: null }).session(session);
    if (!v) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'VEHICLE_NOT_FOUND' });
    }

    const wasDefault = v.is_default === true;

    v.deleted_at = new Date();
    v.is_default = false; // tránh vi phạm unique partial index
    await v.save({ session });

    if (wasDefault) {
      // gán default cho 1 xe còn lại (mới nhất)
      const other = await Vehicle.findOne({
        user_id: userId,
        deleted_at: null
      }).sort({ created_at: -1 }).session(session);
      if (other) {
        // dùng save() để chạy pre-save nếu cần
        other.is_default = true;
        await other.save({ session });
      }
    }

    await session.commitTransaction();
    return res.json({ data: { id: v.id, deleted_at: v.deleted_at } });
  } catch (err) {
    await session.abortTransaction();
    return res.status(400).json({ error: 'DELETE_VEHICLE_FAILED', detail: err.message });
  } finally {
    session.endSession();
  }
};
