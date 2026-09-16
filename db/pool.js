// db/pool.js
require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  // Keep this at or below your Neon plan's concurrent connection limit.
  max: 15,

  // Recycle idle clients so a stale socket (e.g. from Neon autosuspend)
  // doesn't sit in the pool waiting to fail on the next query.
  idleTimeoutMillis: 30_000,

  // Give a cold-starting Neon compute time to wake up before giving up
  // on a new connection.
  connectionTimeoutMillis: 10_000,

  keepAlive: true,
});

// A broken idle client firing this event should never crash the process —
// pg already discards it and makes a fresh connection on the next query.
pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error (recovered):", err.message);
});

// Keeps retrying forever, with a capped backoff, until the database
// is reachable. Never throws — resolves only once connected.
async function connectWithRetry({ baseDelayMs = 3000, maxDelayMs = 30_000 } = {}) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      await pool.query("SELECT 1");
      console.log(`Database connected (attempt ${attempt}).`);
      return;
    } catch (err) {
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      console.error(
        `DB connection attempt ${attempt} failed: ${err.message}. Retrying in ${delay / 1000}s...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

module.exports = pool;
module.exports.connectWithRetry = connectWithRetry;