const router = require('express').Router();
const controller = require('../../../controllers/admin/bookingsController');

router.get('/', controller.listBookings);
router.get('/:id', controller.getBooking);
router.patch('/:id/:status(CANCELLED|NO_SHOW|COMPLETED)', (req, res, next) => {
  req.body.status = req.params.status;
  return controller.updateBookingStatus(req, res, next);
});
module.exports = router;