'use strict';

/**
 * Runs a SQL file against the configured database.
 * Usage: node scripts/run-sql-file.js [path/to/file.sql]
 * Defaults to backend/db/schemas/academic.sql when no argument is given
 * (backend/db/init-practice-db.sql is an older, superseded version of the
 * same tables in the `public` schema — no longer the default, kept only
 * as a historical reference).
 */

const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const DEFAULT_SQL = path.resolve(__dirname, '../db/schemas/academic.sql');
const sqlFile = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_SQL;

async function main() {
  if (!fs.existsSync(sqlFile)) {
    console.error(`File not found: ${sqlFile}`);
    process.exit(1);
  }

  const client = new Client(
    process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {
          host:     process.env.DB_HOST     || 'localhost',
          port:     parseInt(process.env.DB_PORT) || 5432,
          database: process.env.DB_NAME     || 'sql_practice',
          user:     process.env.DB_USER,
          password: process.env.DB_PASSWORD || '',
        }
  );

  await client.connect();
  console.log(`Running ${path.relative(process.cwd(), sqlFile)} ...`);

  const sql = fs.readFileSync(sqlFile, 'utf8');
  await client.query(sql);
  await client.end();

  console.log('Done.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
