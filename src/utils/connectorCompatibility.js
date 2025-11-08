const VEHICLE_PLUG_TO_CONNECTOR_TYPES = {
  CCS2: ["DC_CCS2"],
  CHAdeMO: ["CHAdeMO"],
  AC_Type2: ["AC_Type2"],
  "GB/T": ["GB/T"],
  Other: [],
};

const getConnectorTypesForVehiclePlug = (plugType) => {
  if (!plugType) return [];
  const mapping = VEHICLE_PLUG_TO_CONNECTOR_TYPES[plugType];
  return Array.isArray(mapping) ? mapping : [];
};

module.exports = {
  VEHICLE_PLUG_TO_CONNECTOR_TYPES,
  getConnectorTypesForVehiclePlug,
};
