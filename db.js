const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Create table if not exists
    await client.query(`
       CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  experience TEXT,
  location TEXT,
  skills TEXT[],
  salary TEXT,
  link TEXT UNIQUE NOT NULL,
  source TEXT NOT NULL,
   posted_date TEXT, -- Changed from TIMESTAMP to TEXT to store raw string
  posted_date_original TEXT, -- Optional: if you want to store both
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
)
      `);

    // Verify UNIQUE constraint exists
    const constraints = await client.query(`
        SELECT conname FROM pg_constraint 
        WHERE conrelid = 'jobs'::regclass AND contype = 'u'
      `);

    if (constraints.rows.length === 0) {
      await client.query(
        "ALTER TABLE jobs ADD CONSTRAINT jobs_link_key UNIQUE (link)"
      );
    }

    // Create indexes if not exists
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_jobs_title ON jobs(title);
        CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
        CREATE INDEX IF NOT EXISTS idx_jobs_location ON jobs(location);
        CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
      `);

    await client.query("COMMIT");
    console.log("Database initialized and verified");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Database initialization failed:", error);
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupOldJobs() {
  try {
    const result = await pool.query(
      `DELETE FROM jobs WHERE posted_date < NOW() - INTERVAL '30 DAYS'`
    );
    console.log(`Cleaned up ${result.rowCount} old jobs`);
  } catch (error) {
    console.error("Cleanup failed:", error);
  }
}

module.exports = {
  pool,
  initializeDatabase,
  cleanupOldJobs,
};
