'use strict';

const path = require('path');
const fs   = require('fs');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { Pool } = require('pg');

// ── CSV parser (no external dependencies) ────────────────────────────────────
// Handles quoted fields, embedded commas, and escaped double-quotes ("").

function parseCSVLine(line) {
  const fields = [];
  let field   = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { field += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      fields.push(field); field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

function csvToObjects(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const nonEmpty = lines.filter(l => l.trim());
  if (nonEmpty.length === 0) return [];
  const headers = parseCSVLine(nonEmpty[0]).map(h => h.trim());
  return nonEmpty.slice(1).map(line => {
    const vals = parseCSVLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, (vals[i] ?? '').trim()]));
  });
}

// ── Value converter ───────────────────────────────────────────────────────────

// Parses M/D/YY H:MM or M/D/YYYY H:MM dates (common in CSV exports from spreadsheets).
function parseDateMDY(val) {
  const m = val.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  return new Date(year, parseInt(m[1], 10) - 1, parseInt(m[2], 10),
                  parseInt(m[4], 10), parseInt(m[5], 10));
}

function convertValue(raw, colDef) {
  const isEmpty = raw === '' || raw === null || raw === undefined;

  if (isEmpty) {
    if (colDef.primaryKey)       throw new Error(`Column "${colDef.name}" is PRIMARY KEY but CSV value is empty`);
    if (colDef.nullable === false) throw new Error(`Column "${colDef.name}" is NOT NULL but CSV value is empty`);
    return null; // nullable: true or nullable not specified
  }

  const type = (colDef.type || '').toUpperCase();

  if (type === 'INTEGER' || type === 'INT') {
    const n = parseInt(raw, 10);
    if (isNaN(n)) throw new Error(`Cannot parse "${raw}" as INTEGER for column "${colDef.name}"`);
    return n;
  }

  if (type === 'TIMESTAMP' || type === 'TIMESTAMPTZ') {
    // Try M/D/YY H:MM first (spreadsheet-style), then ISO
    let d = parseDateMDY(raw);
    if (!d || isNaN(d.getTime())) d = new Date(raw);
    if (isNaN(d.getTime())) {
      if (colDef.nullable !== false) return null;
      throw new Error(`Cannot parse "${raw}" as TIMESTAMP for column "${colDef.name}"`);
    }
    return d;
  }

  // TEXT / VARCHAR / default
  return raw;
}

// ── DDL builder ───────────────────────────────────────────────────────────────

function buildCreateTable(schemaName, tableName, columns) {
  const parts = columns.map(col => {
    let def = `  "${col.name}" ${col.type}`;
    if (col.primaryKey) {
      def += ' PRIMARY KEY';
    } else {
      if (col.unique)          def += ' UNIQUE';
      if (col.nullable === false) def += ' NOT NULL';
    }
    if (col.references) {
      def += ` REFERENCES "${schemaName}"."${col.references.table}"("${col.references.column}")`;
    }
    return def;
  });
  return `CREATE TABLE "${schemaName}"."${tableName}" (\n${parts.join(',\n')}\n)`;
}

// ── Batch insert ──────────────────────────────────────────────────────────────
// PostgreSQL supports max 65535 parameters per query.
// With up to 9 columns per row, BATCH_SIZE=500 stays well within the limit.
const BATCH_SIZE = 500;

async function batchInsert(client, schemaName, tableName, columns, rows) {
  const colNames = columns.map(c => `"${c.name}"`).join(', ');
  const colCount = columns.length;

  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch  = rows.slice(offset, offset + BATCH_SIZE);
    const values = [];
    const placeholders = batch.map((row, ri) =>
      '(' + columns.map((_, ci) => {
        values.push(row[ci]);
        return `$${ri * colCount + ci + 1}`;
      }).join(', ') + ')'
    );
    await client.query(
      `INSERT INTO "${schemaName}"."${tableName}" (${colNames}) VALUES ${placeholders.join(', ')}`,
      values
    );
    const done = Math.min(offset + BATCH_SIZE, rows.length);
    process.stdout.write(`\r  Inserting ${tableName}: ${done} / ${rows.length}   `);
  }
  process.stdout.write('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const datasetKey = process.argv[2];
  if (!datasetKey) {
    console.error('Usage: node import-dataset.js <datasetKey>');
    console.error('Example: node import-dataset.js football');
    process.exit(1);
  }

  const datasetDir = path.join(__dirname, `../src/data/datasets/${datasetKey}`);
  const configPath = path.join(datasetDir, 'dataset.config.json');

  if (!fs.existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    console.error(`Expected: backend/src/data/datasets/${datasetKey}/dataset.config.json`);
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const { key, name, schemaName, description, type, loadOrder, tables } = config;

  console.log(`\nImporting dataset: ${name} (${key})`);
  console.log(`Schema: ${schemaName}`);
  console.log(`Tables: ${loadOrder.join(' → ')}\n`);

  const pool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME     || 'sql_practice',
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
  });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Create schema
    console.log(`[1] Creating schema "${schemaName}" if not exists`);
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

    // 2. Drop existing tables in reverse load order (respects FK dependencies)
    console.log(`[2] Dropping existing tables`);
    for (const tableName of [...loadOrder].reverse()) {
      await client.query(`DROP TABLE IF EXISTS "${schemaName}"."${tableName}" CASCADE`);
      console.log(`    Dropped ${schemaName}.${tableName}`);
    }

    // 3. Create tables in load order
    console.log(`[3] Creating tables`);
    for (const tableName of loadOrder) {
      const ddl = buildCreateTable(schemaName, tableName, tables[tableName].columns);
      await client.query(ddl);
      console.log(`    Created ${schemaName}.${tableName}`);
    }

    // 4. Upsert datasets registry row
    console.log(`[4] Upserting datasets row`);
    await client.query(`
      INSERT INTO datasets (key, name, schema_name, description, type, is_active)
      VALUES ($1, $2, $3, $4, $5, true)
      ON CONFLICT (key) DO UPDATE SET
        name        = EXCLUDED.name,
        schema_name = EXCLUDED.schema_name,
        description = EXCLUDED.description,
        type        = EXCLUDED.type,
        is_active   = true
    `, [key, name, schemaName, description || null, type || 'official']);
    console.log(`    datasets.${key} upserted`);

    // 5. Import CSV files
    console.log(`[5] Importing CSV data`);
    for (const tableName of loadOrder) {
      const tableDef = tables[tableName];
      const csvPath  = path.join(datasetDir, 'csv', tableDef.csvFile);

      if (!fs.existsSync(csvPath)) {
        throw new Error(`CSV file not found: ${csvPath}`);
      }

      const records = csvToObjects(fs.readFileSync(csvPath, 'utf8'));
      console.log(`  ${tableName}: ${records.length} records from ${tableDef.csvFile}`);

      const rows = records.map((record, rowIdx) =>
        tableDef.columns.map(col => {
          const csvKey = col.sourceName || col.name;
          const raw    = record[csvKey];
          try {
            return convertValue(raw, col);
          } catch (e) {
            throw new Error(`${tableDef.csvFile} row ${rowIdx + 2}: ${e.message}`);
          }
        })
      );

      await batchInsert(client, schemaName, tableName, tableDef.columns, rows);
    }

    await client.query('COMMIT');
    console.log('\n✓ Import complete');

    // 6. Post-import row count verification
    console.log('\nRow counts:');
    for (const tableName of loadOrder) {
      const r = await pool.query(`SELECT COUNT(*) AS n FROM "${schemaName}"."${tableName}"`);
      console.log(`  ${schemaName}.${tableName}: ${r.rows[0].n}`);
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n✗ Import failed — transaction rolled back');
    console.error(err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
