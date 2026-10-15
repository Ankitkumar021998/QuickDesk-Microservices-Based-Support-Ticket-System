// Tiny REST client for calling auth-service (service-to-service communication).
const config = require('../config');

function upstreamError(message) {
  const err = new Error(message);
  err.status = 502;
  return err;
}

// Returns { id, name, email, role } or null if the user does not exist.
async function getUser(id) {
  let response;
  try {
    response = await fetch(`${config.authServiceUrl}/internal/users/${encodeURIComponent(id)}`, {
      headers: { 'x-internal-api-key': config.internalApiKey },
      signal: AbortSignal.timeout(3000), // do not hang if auth-service is down
    });
  } catch (err) {
    throw upstreamError('Auth service unavailable');
  }
  if (response.status === 404) return null;
  if (!response.ok) throw upstreamError('Auth service returned an unexpected error');
  return response.json();
}

module.exports = { getUser };
