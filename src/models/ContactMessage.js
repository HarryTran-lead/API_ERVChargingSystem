const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const ContactMessageSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true },
    userId: { type: String, ref: "User", index: true },
    name: { type: String, required: true, trim: true, maxlength: 255 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 255 },
    phone: { type: String, trim: true, maxlength: 50 },
    subject: { type: String, required: true, trim: true, maxlength: 255 },
    message: { type: String, required: true, trim: true, maxlength: 5000 },

    status: {
      type: String,
      enum: ["new", "in_progress", "closed"],
      default: "new",
      index: true,
    },

    note: { type: String, trim: true, maxlength: 2000 },
    handledBy: { type: String, ref: "User", index: true },
    handledAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ContactMessage", ContactMessageSchema);