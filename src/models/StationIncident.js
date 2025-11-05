const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { INCIDENT_SEVERITY, INCIDENT_STATUS } = require('../constants/enums');

const StationIncidentSchema = new mongoose.Schema(
  {
    id: { type: String, default: uuidv4, unique: true },
    stationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Station',
      required: true,
      index: true,
    },
    connectorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Connector',
      index: true,
    },
    reportedBy: { type: String, ref: 'User', required: true, index: true },
    title: { type: String, trim: true, maxlength: 200 },
    description: { type: String, required: true, trim: true, maxlength: 4000 },
    severity: {
      type: String,
      enum: INCIDENT_SEVERITY,
      default: 'MEDIUM',
    },
    status: {
      type: String,
      enum: INCIDENT_STATUS,
      default: 'OPEN',
      index: true,
    },
    attachments: [{ type: String, trim: true }],
    resolvedBy: { type: String, ref: 'User' },
    resolvedAt: { type: Date },
    meta: { type: Object },
  },
  { timestamps: true }
);

StationIncidentSchema.index({ stationId: 1, status: 1 });

module.exports = mongoose.model('StationIncident', StationIncidentSchema);