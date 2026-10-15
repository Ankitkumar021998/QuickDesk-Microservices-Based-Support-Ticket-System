const bcrypt = require('bcryptjs');
const config = require('./config');
const app = require('./app');
const { pool, init } = require('./db');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectWithRetry(retries = 10) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await init();
      return;
    } catch (err) {
      console.error(`PostgreSQL not ready (${attempt}/${retries}): ${err.message}`);
      if (attempt === retries) throw err;
      await sleep(3000);
    }
  }
}

// Creates the first admin from ADMIN_* env vars if it does not exist yet.
async function seedAdmin() {
  if (!config.adminEmail || !config.adminPassword) return;
  const email = config.adminEmail.trim().toLowerCase();
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (rows.length) return;
  const hash = await bcrypt.hash(config.adminPassword, 10);
  await pool.query(
    "INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'admin')",
    [config.adminName, email, hash]
  );
  console.log(`Seeded admin account: ${email}`);
}

(async () => {
  await connectWithRetry();
  await seedAdmin();
  const server = app.listen(config.port, () => console.log(`auth-service listening on :${config.port}`));

  const shutdown = () => server.close(async () => { await pool.end(); process.exit(0); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
