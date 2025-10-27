/**
 * Updated by trungquandev.com's author on August 17 2023
 * YouTube: https://youtube.com/@trungquandev
 * "A bit of fragrance clings to the hand that gives flowers!"
 */

/**
 * Calculate SOC (State of Charge) based on actual energy charged
 * @param {number} socStart - Starting SOC percentage
 * @param {number} batteryKwh - Battery capacity in kWh
 * @param {number} connectorPowerKw - Connector power in kW
 * @param {number} chargingMinutes - Minutes of charging
 * @returns {number} Current SOC percentage
 */
const calculateSocFromEnergy = (
  socStart,
  batteryKwh,
  connectorPowerKw,
  chargingMinutes
) => {
  if (
    !batteryKwh ||
    batteryKwh <= 0 ||
    !connectorPowerKw ||
    connectorPowerKw <= 0
  ) {
    return socStart;
  }

  const energyCharged = (connectorPowerKw * chargingMinutes) / 60; // kWh
  const socIncrease = (energyCharged / batteryKwh) * 100;
  const newSoc = Math.min(100, socStart + socIncrease);

  return Number(newSoc.toFixed(1));
};

/**
 * Calculate percentage of battery that can be charged in 30 minutes
 * @param {number} socCurrent - Current SOC percentage
 * @param {number} batteryKwh - Battery capacity in kWh
 * @param {number} connectorPowerKw - Connector power in kW
 * @returns {number} Percentage that can be charged in 30 minutes
 */
const calculateChargePercentageIn30Min = (
  socCurrent,
  batteryKwh,
  connectorPowerKw
) => {
  if (
    !batteryKwh ||
    batteryKwh <= 0 ||
    !connectorPowerKw ||
    connectorPowerKw <= 0
  ) {
    return 0;
  }

  const energyIn30Min = (connectorPowerKw * 30) / 60; // kWh in 30 minutes
  const percentageIn30Min = (energyIn30Min / batteryKwh) * 100;

  return Number(Math.min(percentageIn30Min, 100 - socCurrent).toFixed(1));
};

/**
 * Calculate time to full charge in minutes
 * @param {number} socCurrent - Current SOC percentage
 * @param {number} batteryKwh - Battery capacity in kWh
 * @param {number} connectorPowerKw - Connector power in kW
 * @returns {number} Minutes to full charge
 */
const calculateTimeToFullCharge = (
  socCurrent,
  batteryKwh,
  connectorPowerKw
) => {
  if (
    !batteryKwh ||
    batteryKwh <= 0 ||
    !connectorPowerKw ||
    connectorPowerKw <= 0
  ) {
    return null;
  }

  const remainingPercentage = Math.max(0, 100 - socCurrent);
  const remainingEnergy = (remainingPercentage / 100) * batteryKwh; // kWh
  const timeToFull = (remainingEnergy / connectorPowerKw) * 60; // minutes

  return Number(timeToFull.toFixed(1));
};

/**
 * Calculate actual charge duration needed to reach target SOC
 * @param {number} socStart - Starting SOC percentage
 * @param {number} socTarget - Target SOC percentage
 * @param {number} batteryKwh - Battery capacity in kWh
 * @param {number} connectorPowerKw - Connector power in kW
 * @returns {number} Minutes needed to reach target SOC
 */
const calculateChargeDurationFromSoc = (
  socStart,
  socTarget,
  batteryKwh,
  connectorPowerKw
) => {
  if (
    !batteryKwh ||
    batteryKwh <= 0 ||
    !connectorPowerKw ||
    connectorPowerKw <= 0
  ) {
    return 30; // fallback to default
  }

  const socIncrease = Math.max(0, socTarget - socStart);
  const energyNeeded = (socIncrease / 100) * batteryKwh; // kWh
  const durationMinutes = (energyNeeded / connectorPowerKw) * 60; // minutes

  return Number(Math.max(1, durationMinutes).toFixed(1));
};

module.exports = {
  calculateSocFromEnergy,
  calculateChargePercentageIn30Min,
  calculateTimeToFullCharge,
  calculateChargeDurationFromSoc,
};
