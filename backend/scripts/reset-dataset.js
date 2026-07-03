'use strict';

const path     = require('path');
const fs       = require('fs');
const readline = require('readline');

require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { Pool } = require('pg');

// ── Safety ────────────────────────────────────────────────────────────────────

const VALID_KEY_RE = /^[a-zA-Z0-9_-]+$/;

// These schema names must never be dropped.
const BLOCKED_KEYS = new Set([
  'public', 'pg_catalog', 'information_schema',
  'pg_toast', 'pg_temp', 'pg_internal',
]);

function validateKey(key) {
  if (!key || key.trim() === '') return 'datasetKey is required';
  if (!VALID_KEY_RE.test(key))    return `datasetKey must match /^[a-zA-Z0-9_-]+$/ — got: "${key}"`;
  if (BLOCKED_KEYS.has(key))      return `"${key}" is a protected name and cannot be reset`;
  return null;
}

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const positional = [];
  const flags      = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) flags[arg.slice(2)] = true;
    else positional.push(arg);
  }
  return { positional, flags };
}

// ── Interactive confirmation ───────────────────────────────────────────────────

function askConfirm(datasetKey) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\nType the dataset key to confirm: `, answer => {
      rl.close();
      resolve(answer.trim() === datasetKey);
    });
  });
}

// ── File helpers ──────────────────────────────────────────────────────────────

function listDir(dir) {
  try { return fs.readdirSync(dir); } catch { return null; }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const datasetKey = positional[0];
  const dryRun     = flags['dry-run'] || false;
  const skipPrompt = flags['yes']     || false;

  // ── Validate key ────────────────────────────────────────────────────────
  const keyErr = validateKey(datasetKey);
  if (keyErr) {
    console.error(`Error: ${keyErr}`);
    console.error('Usage: npm run dataset:reset -- <datasetKey> [--dry-run] [--yes]');
    process.exit(1);
  }

  // ── Locate paths ────────────────────────────────────────────────────────
  const datasetDir  = path.join(__dirname, `../src/data/datasets/${datasetKey}`);
  const rawDir      = path.join(datasetDir, 'raw');
  const csvDir      = path.join(datasetDir, 'csv');
  const configPath  = path.join(datasetDir, 'dataset.config.json');

  if (!fs.existsSync(datasetDir)) {
    console.error(`Error: Dataset folder not found: ${datasetDir}`);
    process.exit(1);
  }

  // ── Inventory current state ─────────────────────────────────────────────
  const rawFiles    = listDir(rawDir);   // null if missing
  const csvFiles    = listDir(csvDir);   // null if missing
  const configExists = fs.existsSync(configPath);

  // ── Print header ────────────────────────────────────────────────────────
  const mode = dryRun ? ' [DRY RUN]' : '';
  console.log(`\nDataset reset${mode} — ${datasetKey}`);
  console.log(`Folder: ${datasetDir}\n`);

  if (rawFiles === null) {
    console.log(`⚠  WARNING: raw/ not found — source files may be missing`);
    console.log(`   Expected: ${rawDir}`);
  } else {
    console.log(`raw/ preserved (${rawFiles.length} file(s) untouched):`);
    rawFiles.forEach(f => console.log(`  ${f}`));
  }

  // ── Print deletion plan ─────────────────────────────────────────────────
  console.log('\nWill delete:');
  console.log(`  • PostgreSQL schema "${datasetKey}" (DROP SCHEMA IF EXISTS CASCADE)`);
  console.log(`  • datasets registry row for key="${datasetKey}"`);
  if (csvFiles !== null && csvFiles.length > 0) {
    console.log(`  • csv/ (${csvFiles.length} file(s)) — then recreate empty`);
    csvFiles.forEach(f => console.log(`    - ${f}`));
  } else if (csvFiles !== null) {
    console.log(`  • csv/ exists but is already empty — will recreate`);
  } else {
    console.log(`  • csv/ does not exist — will create empty`);
  }
  if (configExists) {
    console.log(`  • dataset.config.json`);
  } else {
    console.log(`  (dataset.config.json not present — skipped)`);
  }

  console.log('\nWill keep:');
  console.log(`  • raw/ and all source files`);
  console.log(`  • all other datasets`);
  console.log(`  • all app tables (users, sessions, progress, tasks)`);

  // ── Dry-run exit ────────────────────────────────────────────────────────
  if (dryRun) {
    console.log('\n[dry-run] No changes made.');
    return;
  }

  // ── Confirm ─────────────────────────────────────────────────────────────
  if (!skipPrompt) {
    const ok = await askConfirm(datasetKey);
    if (!ok) {
      console.log('Aborted — no changes made.');
      process.exit(0);
    }
  }

  console.log('');

  // ── DB: drop schema + registry row ─────────────────────────────────────
  const pool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME     || 'sql_practice',
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
  });

  let schemaDropped   = false;
  let registryDeleted = false;

  try {
    const { rows } = await pool.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
      [datasetKey]
    );

    if (rows.length > 0) {
      await pool.query(`DROP SCHEMA IF EXISTS "${datasetKey}" CASCADE`);
      schemaDropped = true;
      console.log(`✓ Dropped PostgreSQL schema "${datasetKey}"`);
    } else {
      console.log(`  Schema "${datasetKey}" not found in PostgreSQL — skipped`);
    }

    // Always attempt to clean up the datasets registry row
    const del = await pool.query(`DELETE FROM datasets WHERE key = $1 RETURNING key`, [datasetKey]);
    if (del.rowCount > 0) {
      registryDeleted = true;
      console.log(`✓ Removed datasets registry row (key="${datasetKey}")`);
    } else {
      console.log(`  No datasets registry row found for key="${datasetKey}" — skipped`);
    }
  } catch (err) {
    console.error(`✗ DB error: ${err.message}`);
    console.error('  Continuing with file cleanup...');
  } finally {
    await pool.end();
  }

  // ── Files: delete csv/ and recreate empty ───────────────────────────────
  if (csvFiles !== null) {
    fs.rmSync(csvDir, { recursive: true, force: true });
    console.log(`✓ Deleted csv/`);
  }
  fs.mkdirSync(csvDir, { recursive: true });
  console.log(`✓ Created empty csv/`);

  // ── Files: delete config ────────────────────────────────────────────────
  if (configExists) {
    fs.unlinkSync(configPath);
    console.log(`✓ Deleted dataset.config.json`);
  } else {
    console.log(`  dataset.config.json not found — skipped`);
  }

  // ── Final report ────────────────────────────────────────────────────────
  console.log('\n── Reset complete ──────────────────────────────────────────────────');
  console.log(`  Dataset        : ${datasetKey}`);
  console.log(`  DB schema      : ${schemaDropped   ? `dropped` : 'was not present'}`);
  console.log(`  DB registry    : ${registryDeleted ? `removed`  : 'was not present'}`);
  console.log(`  csv/           : ${csvFiles !== null ? 'deleted and ' : ''}recreated empty`);
  console.log(`  config         : ${configExists ? 'deleted' : 'was not present'}`);
  console.log(`  raw/           : preserved (untouched)`);

  if (rawFiles === null) {
    console.log('\n  ⚠  raw/ was not found — you will need source files before re-importing');
  } else {
    console.log('\nTo re-import from scratch:');
    console.log(`  npm run dataset:generate-config -- ${datasetKey}`);
    console.log(`  npm run dataset:build-sample -- ${datasetKey}`);
    console.log(`  npm run dataset:import -- ${datasetKey}`);
  }
}

main().catch(err => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
