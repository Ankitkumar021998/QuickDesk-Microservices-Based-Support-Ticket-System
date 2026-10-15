function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

module.exports = {
  port: parseInt(process.env.PORT || '4002', 10),
  mongoUri: required('MONGO_URI'),
  jwtSecret: required('JWT_SECRET'),
  internalApiKey: required('INTERNAL_API_KEY'),
  authServiceUrl: required('AUTH_SERVICE_URL'),
};
