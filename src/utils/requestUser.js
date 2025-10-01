const { HttpError } = require("./errors");

const toPlainObject = (user) => {
  if (!user) return null;
  if (typeof user.toObject === "function") {
    return user.toObject();
  }
  if (typeof user.toJSON === "function") {
    return user.toJSON();
  }
  return user;
};

const ensureRequestUser = (req) => {
  const user = req.user;
  if (!user) {
    throw new HttpError(401, "Authentication required");
  }
  return user;
};

const ensureRequestUserId = (req) => {
  const user = ensureRequestUser(req);
  const plain = toPlainObject(user);
  const explicitId =
    user.id ||
    user.user_id ||
    plain?.id ||
    plain?.user_id ||
    plain?._id?.toString();

  if (!explicitId) {
    throw new HttpError(401, "Authenticated user identifier is missing");
  }

  return explicitId;
};

module.exports = {
  ensureRequestUser,
  ensureRequestUserId,
};
