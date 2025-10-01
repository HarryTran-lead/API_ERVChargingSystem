// src/middleware/errorHandler.js
const { HttpError } = require("../utils/errors");

function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      success: false,
      status: err.status,
      message: err.message,
    });
  }

  console.error(err); // log chi tiết trên server
  return res.status(500).json({
    success: false,
    status: 500,
    message: "Internal Server Error",
  });
}

module.exports = errorHandler;
