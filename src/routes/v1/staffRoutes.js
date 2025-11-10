const router = require('express').Router();
const { protect } = require('../../middlewares/authMiddleware');
const { ROLES } = require('../../constants/enums');
const operations = require('../../controllers/staff/staffOperationsController');

router.use(protect([ROLES.STAFF, ROLES.ADMIN]));

router.get('/stations/status', operations.listStationStatuses);
router.get('/bookings', operations.listOperationalBookings);
router.get('/sessions', operations.listOperationalSessions);
router.post('/payments/onsite', operations.recordOnsitePayment);
router.post('/incidents', operations.reportIncident);
router.get('/incidents', operations.listIncidentReports);
router.patch('/incidents/:id/status', operations.updateIncidentStatus);
router.post('/bookings/proxy', operations.createProxyBooking);
router.get('/sessions/:id/invoice', operations.getSessionInvoice);
router.get('/invoices', operations.listInvoices);
router.patch('/chargers/:id/power', operations.toggleChargerPower);

module.exports = router;