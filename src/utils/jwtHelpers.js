const normalizeSecret = (raw) => String(raw || '').replace(/\r?\n/g, '').trim();

const getAllowedAlgs = () => {
  const env = process.env.JWT_ALGS || 'HS256,HS512';
  return env
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
};

module.exports = {
  normalizeSecret,
  getAllowedAlgs,
};