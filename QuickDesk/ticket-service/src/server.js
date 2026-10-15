const mongoose = require('mongoose');
const config = require('./config');
const app = require('./app');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectWithRetry(retries = 10) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
      console.log('Connected to MongoDB');
      return;
    } catch (err) {
      console.error(`MongoDB not ready (${attempt}/${retries}): ${err.message}`);
      if (attempt === retries) throw err;
      await sleep(3000);
    }
  }
}

(async () => {
  await connectWithRetry();
  const server = app.listen(config.port, () => console.log(`ticket-service listening on :${config.port}`));

  const shutdown = () => server.close(async () => { await mongoose.disconnect(); process.exit(0); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
