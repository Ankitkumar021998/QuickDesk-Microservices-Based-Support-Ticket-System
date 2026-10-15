const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({ connectionString: config.databaseUrl });

// Creates the users table if it does not exist yet.
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      name          VARCHAR(100) NOT NULL,
      email         VARCHAR(255) NOT NULL UNIQUE,
      password_hash TEXT         NOT NULL,
      role          VARCHAR(10)  NOT NULL DEFAULT 'user'
                    CHECK (role IN ('user', 'agent', 'admin')),
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
}

module.exports = { pool, init };
