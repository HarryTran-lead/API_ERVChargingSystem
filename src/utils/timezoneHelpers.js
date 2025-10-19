/**
 * Utility functions for timezone handling
 */

/**
 * Format date to Vietnam timezone string (+07:00)
 * @param {Date|string} date - Date to format
 * @returns {string} - ISO string with Vietnam timezone
 */
const formatToVietnamTime = (date) => {
  if (!date) return null;

  const dateObj = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(dateObj.getTime())) return null;

  // Convert to Vietnam timezone (+7 hours)
  const vietnamOffset = 7 * 60; // 7 hours in minutes
  const vietnamTime = new Date(dateObj.getTime() + vietnamOffset * 60 * 1000);

  return vietnamTime.toISOString().replace("Z", "+07:00");
};

/**
 * Format booking object with Vietnam timezone
 * @param {Object} booking - Booking object
 * @returns {Object} - Booking object with formatted dates
 */
const formatBookingDates = (booking) => {
  if (!booking) return booking;

  const bookingObj =
    typeof booking.toObject === "function" ? booking.toObject() : booking;

  // Format all date fields to Vietnam timezone
  const dateFields = [
    "slotStart",
    "slotEnd",
    "checkInDeadline",
    "createdAt",
    "updatedAt",
  ];

  dateFields.forEach((field) => {
    if (bookingObj[field]) {
      bookingObj[field] = formatToVietnamTime(bookingObj[field]);
    }
  });

  return bookingObj;
};

/**
 * Format session object with Vietnam timezone
 * @param {Object} session - Session object
 * @returns {Object} - Session object with formatted dates
 */
const formatSessionDates = (session) => {
  if (!session) return session;

  const sessionObj =
    typeof session.toObject === "function" ? session.toObject() : session;

  // Format all date fields to Vietnam timezone
  const dateFields = [
    "startedAt",
    "stoppedAt",
    "expectedFullAt",
    "slotEnd",
    "idleFeeNoticeAt",
    "createdAt",
    "updatedAt",
  ];

  dateFields.forEach((field) => {
    if (sessionObj[field]) {
      sessionObj[field] = formatToVietnamTime(sessionObj[field]);
    }
  });

  return sessionObj;
};

/**
 * Format invoice object with Vietnam timezone
 * @param {Object} invoice - Invoice object
 * @returns {Object} - Invoice object with formatted dates
 */
const formatInvoiceDates = (invoice) => {
  if (!invoice) return invoice;

  const invoiceObj =
    typeof invoice.toObject === "function" ? invoice.toObject() : invoice;

  // Format all date fields to Vietnam timezone
  const dateFields = [
    "issued_at",
    "due_at",
    "paid_at",
    "createdAt",
    "updatedAt",
  ];

  dateFields.forEach((field) => {
    if (invoiceObj[field]) {
      invoiceObj[field] = formatToVietnamTime(invoiceObj[field]);
    }
  });

  return invoiceObj;
};

/**
 * Format vehicle object with Vietnam timezone
 * @param {Object} vehicle - Vehicle object
 * @returns {Object} - Vehicle object with formatted dates
 */
const formatVehicleDates = (vehicle) => {
  if (!vehicle) return vehicle;

  const vehicleObj =
    typeof vehicle.toObject === "function" ? vehicle.toObject() : vehicle;

  // Format all date fields to Vietnam timezone
  const dateFields = ["created_at", "updated_at", "deleted_at"];

  dateFields.forEach((field) => {
    if (vehicleObj[field]) {
      vehicleObj[field] = formatToVietnamTime(vehicleObj[field]);
    }
  });

  return vehicleObj;
};

module.exports = {
  formatToVietnamTime,
  formatBookingDates,
  formatSessionDates,
  formatInvoiceDates,
  formatVehicleDates,
};
