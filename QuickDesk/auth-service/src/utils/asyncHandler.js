// Forwards errors from async route handlers to the central error handler.
// (Express 5 does this natively; the wrapper keeps the code working on Express 4 too.)
module.exports = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
