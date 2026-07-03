'use strict';

const path = require('path');
const fs   = require('fs');

// ── CSV parser ────────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  const fields = [];
  let field = '', inQuote = false;
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

function splitLines(text) {
  const t = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text; // strip BOM
  return t.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
}

// ── CLI parser ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key  = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, flags };
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const datasetKey = positional[0];

  if (!datasetKey) {
    console.error('Usage: node build-dataset-sample.js <datasetKey> [--mode consistent|preserve] [--root <table>] [--limit <N>]');
    console.error('Examples:');
    console.error('  node build-dataset-sample.js cinema --mode preserve --limit 100');
    console.error('  node build-dataset-sample.js cinema --mode consistent --root films --limit 100');
    process.exit(1);
  }

  const datasetDir = path.join(__dirname, '../src/data/datasets', datasetKey);
  const configPath = path.join(datasetDir, 'dataset.config.json');

  if (!fs.existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    console.error('Run: npm run dataset:generate-config -- ' + datasetKey);
    process.exit(1);
  }

  const config     = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const { tables } = config;
  const tableNames = Object.keys(tables);

  const sampleOptions = config.sampleOptions || {};
  const mode      = flags.mode  || sampleOptions.mode      || 'consistent';
  const rootTable = flags.root  || sampleOptions.rootTable || config.sample?.rootTable || null;
  const rawLimit  = flags.limit || sampleOptions.limit     || config.sample?.limit     || null;
  const limit     = rawLimit !== null ? parseInt(rawLimit, 10) : null;

  if (mode !== 'consistent' && mode !== 'preserve') {
    console.error(`Unknown mode: "${mode}". Use "consistent" or "preserve".`);
    process.exit(1);
  }

  if (mode === 'consistent') {
    if (!rootTable) {
      console.error('Error: --root <table> is required in "consistent" mode.');
      console.error('Or set sampleOptions.rootTable in dataset.config.json');
      process.exit(1);
    }
    if (!tableNames.includes(rootTable)) {
      console.error(`Error: root table "${rootTable}" not found in config.`);
      console.error(`Available tables: ${tableNames.join(', ')}`);
      process.exit(1);
    }
    if (!limit || isNaN(limit) || limit <= 0) {
      console.error('Error: --limit <N> must be a positive integer in "consistent" mode.');
      console.error('Or set sampleOptions.limit in dataset.config.json');
      process.exit(1);
    }
  } else {
    if (limit !== null && (isNaN(limit) || limit <= 0)) {
      console.error('Error: --limit <N> must be a positive integer.');
      process.exit(1);
    }
  }

  const rawDir = path.join(datasetDir, 'raw');
  const csvDir = path.join(datasetDir, 'csv');

  if (!fs.existsSync(rawDir)) {
    console.error(`Raw directory not found: ${rawDir}`);
    console.error('Place full source CSV files there before building a sample. Expected files:');
    for (const [, tDef] of Object.entries(tables)) {
      console.error(`  ${path.join(rawDir, tDef.csvFile)}`);
    }
    process.exit(1);
  }

  console.log(`\nDataset sample builder — ${config.name} (${datasetKey})`);
  if (mode === 'consistent') {
    console.log(`Mode       : consistent (root: ${rootTable}, limit: ${limit} rows)`);
  } else {
    console.log(`Mode       : preserve${limit ? ` (limit: ${limit} rows per table)` : ' (all rows)'}`);
  }
  console.log(`Source     : ${rawDir}`);
  console.log(`Output     : ${csvDir}\n`);

  // ── Read all source CSVs ───────────────────────────────────────────────────

  // allRows[t]    = [{csvColName: rawVal, ...}, ...]  — parsed data rows
  // rawLines[t]   = ['line1', 'line2', ...]           — original data lines (no header)
  // headerLine[t] = string                             — original header line (or generated)

  const allRows    = {};
  const rawLines   = {};
  const headerLine = {};

  console.log('Reading source CSVs:');
  for (const tableName of tableNames) {
    const tableDef = tables[tableName];
    const srcPath  = path.join(rawDir, tableDef.csvFile);

    if (!fs.existsSync(srcPath)) {
      console.error(`\nSource CSV not found: ${srcPath}`);
      console.error(`Place the full source CSV for "${tableName}" in: ${rawDir}`);
      process.exit(1);
    }

    const lines = splitLines(fs.readFileSync(srcPath, 'utf8'));

    if (lines.length === 0) {
      const csvNames = tableDef.columns.map(c => c.sourceName || c.name);
      headerLine[tableName] = csvNames.join(',');
      rawLines[tableName]   = [];
      allRows[tableName]    = [];
      console.log(`  ${tableName.padEnd(16)}: 0 rows (empty file)`);
      continue;
    }

    // Detect header: check overlap between first-row fields and config CSV column names
    const firstFields    = parseCSVLine(lines[0]).map(f => f.trim().toLowerCase());
    const configCsvNames = tableDef.columns.map(c => (c.sourceName || c.name).toLowerCase());
    const matchCount     = configCsvNames.filter(n => firstFields.includes(n)).length;
    const hasHeader      = configCsvNames.length > 0 && (matchCount / configCsvNames.length) > 0.5;

    let csvColOrder;
    if (hasHeader) {
      headerLine[tableName] = lines[0];
      rawLines[tableName]   = lines.slice(1);
      csvColOrder           = parseCSVLine(lines[0]).map(f => f.trim());
    } else {
      csvColOrder           = tableDef.columns.map(c => c.sourceName || c.name);
      headerLine[tableName] = csvColOrder.join(',');
      rawLines[tableName]   = lines;
    }

    allRows[tableName] = rawLines[tableName].map(line => {
      const fields = parseCSVLine(line);
      const obj    = {};
      for (let i = 0; i < csvColOrder.length; i++) {
        obj[csvColOrder[i]] = (fields[i] ?? '').trim();
      }
      return obj;
    });

    console.log(`  ${tableName.padEnd(16)}: ${allRows[tableName].length.toLocaleString()} rows`);
  }

  // ── Preserve mode: copy first N rows per table, no FK filtering ──────────
  // FK integrity is fully delegated to the importer (importOptions.missingReferences).

  if (mode === 'preserve') {
    const cap = (n) => limit !== null ? Math.min(limit, n) : n;

    if (!fs.existsSync(csvDir)) fs.mkdirSync(csvDir, { recursive: true });

    const maxLen = Math.max(...tableNames.map(t => t.length));
    console.log('Selected rows per table (no FK filtering):');
    for (const tableName of tableNames) {
      const tableDef = tables[tableName];
      const count    = cap(rawLines[tableName].length);
      const total    = rawLines[tableName].length;
      const outPath  = path.join(csvDir, tableDef.csvFile);
      const lines    = [headerLine[tableName], ...rawLines[tableName].slice(0, count)];
      fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
      console.log(`  ${tableName.padEnd(maxLen)}: ${count.toLocaleString()} / ${total.toLocaleString()} rows`);
    }

    console.log('\n✓ Sample written to: ' + csvDir);
    console.log('  Run: npm run dataset:import -- ' + datasetKey);
    return;
  }

  // ── Collect FK relationships from config ───────────────────────────────────
  // Each FK: child table has a column with `references` pointing to parent table+column.
  // We use CSV column names (sourceName || name) throughout.

  const fkRels = []; // [{ childTable, childCsvCol, parentTable, parentCsvCol }]

  for (const tableName of tableNames) {
    for (const col of tables[tableName].columns) {
      if (!col.references) continue;
      const { table: parentTable, column: parentConfigCol } = col.references;

      if (!tables[parentTable]) {
        console.warn(`Warning: FK ${tableName}.${col.name} references unknown table "${parentTable}" — skipped`);
        continue;
      }

      const parentColDef = tables[parentTable].columns.find(c => c.name === parentConfigCol);
      const parentCsvCol = parentColDef ? (parentColDef.sourceName || parentColDef.name) : parentConfigCol;
      const childCsvCol  = col.sourceName || col.name;

      fkRels.push({ childTable: tableName, childCsvCol, parentTable, parentCsvCol });
    }
  }

  const involvedTables = new Set(fkRels.flatMap(r => [r.childTable, r.parentTable]));

  if (fkRels.length === 0) {
    console.log('\nNo FK relationships found in config — all tables are independent.');
  } else {
    console.log('\nFK relationships:');
    for (const r of fkRels) {
      console.log(`  ${r.childTable}.${r.childCsvCol} → ${r.parentTable}.${r.parentCsvCol}`);
    }
  }

  // ── Build FK lookup indexes ───────────────────────────────────────────────
  //
  // parentIndex[parentTable][parentCsvCol][value] = rowIdx
  //   → given a FK value, find the matching parent row
  //
  // childrenIndex[parentTable][parentCsvCol][parentValue] = [{childTable, rowIdx}, ...]
  //   → given a parent row's referenced-column value, find all child rows

  const parentIndex   = {};
  const childrenIndex = {};

  for (const rel of fkRels) {
    const { childTable, childCsvCol, parentTable, parentCsvCol } = rel;

    // parentIndex — built once per (parentTable, parentCsvCol) pair
    if (!parentIndex[parentTable])               parentIndex[parentTable] = {};
    if (!parentIndex[parentTable][parentCsvCol]) {
      parentIndex[parentTable][parentCsvCol] = {};
      for (let i = 0; i < allRows[parentTable].length; i++) {
        const val = allRows[parentTable][i][parentCsvCol];
        if (val !== '' && val !== undefined) {
          parentIndex[parentTable][parentCsvCol][val] = i;
        }
      }
    }

    // childrenIndex — add entries for this FK rel (multiple rels may share the same parent key)
    if (!childrenIndex[parentTable])                childrenIndex[parentTable] = {};
    if (!childrenIndex[parentTable][parentCsvCol])  childrenIndex[parentTable][parentCsvCol] = {};
    for (let i = 0; i < allRows[childTable].length; i++) {
      const fkVal = allRows[childTable][i][childCsvCol];
      if (fkVal !== '' && fkVal !== undefined) {
        if (!childrenIndex[parentTable][parentCsvCol][fkVal]) {
          childrenIndex[parentTable][parentCsvCol][fkVal] = [];
        }
        childrenIndex[parentTable][parentCsvCol][fkVal].push({ childTable, rowIdx: i });
      }
    }
  }

  // ── Initialize selection ──────────────────────────────────────────────────

  const selected = {};
  for (const t of tableNames) selected[t] = new Set();

  // Root table: first N rows
  const seedCount = Math.min(limit, allRows[rootTable].length);
  for (let i = 0; i < seedCount; i++) selected[rootTable].add(i);

  // Independent tables (not connected to any FK): first N rows
  for (const t of tableNames) {
    if (!involvedTables.has(t)) {
      const n = Math.min(limit, allRows[t].length);
      for (let i = 0; i < n; i++) selected[t].add(i);
    }
  }

  // ── Iterative bidirectional expansion ────────────────────────────────────
  // Each pass: upward (child → parent) + downward (parent → all its children).
  // Repeat until no new rows are added.

  console.log('\nExpanding sample:');
  const iterLog = [];
  let changed = true;
  let iter    = 0;

  while (changed) {
    changed = false;
    iter++;

    // Snapshot current selection — prevents mutation-during-iteration surprises
    const snap = {};
    for (const t of tableNames) snap[t] = new Set(selected[t]);

    const added = {};

    for (const rel of fkRels) {
      const { childTable, childCsvCol, parentTable, parentCsvCol } = rel;

      // Upward: selected child rows pull in their parent rows
      for (const rowIdx of snap[childTable]) {
        const fkVal = allRows[childTable][rowIdx][childCsvCol];
        if (!fkVal || fkVal === '') continue;

        const parentRowIdx = parentIndex[parentTable]?.[parentCsvCol]?.[fkVal];
        if (parentRowIdx !== undefined && !selected[parentTable].has(parentRowIdx)) {
          selected[parentTable].add(parentRowIdx);
          added[parentTable] = (added[parentTable] || 0) + 1;
          changed = true;
        }
      }

      // Downward: selected parent rows pull in all their child rows
      for (const rowIdx of snap[parentTable]) {
        const pkVal = allRows[parentTable][rowIdx][parentCsvCol];
        if (!pkVal || pkVal === '') continue;

        const children = childrenIndex[parentTable]?.[parentCsvCol]?.[pkVal] || [];
        for (const { childTable: ct, rowIdx: ci } of children) {
          if (!selected[ct].has(ci)) {
            selected[ct].add(ci);
            added[ct] = (added[ct] || 0) + 1;
            changed = true;
          }
        }
      }
    }

    const total    = Object.values(added).reduce((s, v) => s + v, 0);
    const addedStr = Object.entries(added).map(([t, n]) => `${t}: +${n}`).join(', ');
    iterLog.push(`  Iteration ${iter}: ${total === 0 ? 'no changes' : `+${total} rows (${addedStr})`}`);
  }
  iterLog.push(`  Stable after ${iter} iteration(s)`);
  iterLog.forEach(l => console.log(l));

  // ── Detect true orphans in selected rows ─────────────────────────────────
  // An orphan is a selected child row whose FK value does not exist in the source
  // raw/ data at all (not just absent from the sample — truly missing upstream).

  const orphans = {}; // tableName → { count, examples[] }

  for (const rel of fkRels) {
    const { childTable, childCsvCol, parentTable, parentCsvCol } = rel;
    if (!orphans[childTable]) orphans[childTable] = { count: 0, examples: [] };

    for (const rowIdx of selected[childTable]) {
      const fkVal = allRows[childTable][rowIdx][childCsvCol];
      if (!fkVal || fkVal === '') continue;

      const existsInRaw = parentIndex[parentTable]?.[parentCsvCol]?.[fkVal] !== undefined;
      if (!existsInRaw) {
        orphans[childTable].count++;
        if (orphans[childTable].examples.length < 10) {
          orphans[childTable].examples.push(`${childCsvCol}=${fkVal}`);
        }
      }
    }
  }

  // ── Write output CSVs ─────────────────────────────────────────────────────

  if (!fs.existsSync(csvDir)) fs.mkdirSync(csvDir, { recursive: true });

  for (const tableName of tableNames) {
    const tableDef = tables[tableName];
    const outPath  = path.join(csvDir, tableDef.csvFile);
    const indices  = [...selected[tableName]].sort((a, b) => a - b);
    const lines    = [headerLine[tableName], ...indices.map(i => rawLines[tableName][i])];
    fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  }

  // ── Report ────────────────────────────────────────────────────────────────

  const maxLen = Math.max(...tableNames.map(t => t.length));

  console.log('\nSelected rows per table:');
  for (const t of tableNames) {
    const sel      = selected[t].size;
    const total    = allRows[t].length;
    const excluded = total - sel;
    const tag      = !involvedTables.has(t) ? ' (independent)' : '';
    const excStr   = excluded > 0 ? `, ${excluded.toLocaleString()} excluded` : '';
    console.log(`  ${t.padEnd(maxLen)}: ${sel.toLocaleString().padStart(6)} / ${total.toLocaleString().padStart(7)} selected${excStr}${tag}`);
  }

  const hasOrphans = Object.values(orphans).some(o => o.count > 0);
  console.log('');
  if (hasOrphans) {
    console.log('Orphan FK references (parent not in source data):');
    for (const [t, o] of Object.entries(orphans)) {
      if (o.count > 0) {
        console.log(`  ${t}: ${o.count} orphan row(s) — examples: ${o.examples.join(', ')}`);
      }
    }
  } else {
    console.log('No orphan FK references.');
  }

  console.log('\nRelationship traversal:');
  if (fkRels.length === 0) {
    console.log('  (none)');
  } else {
    for (const r of fkRels) {
      console.log(`  ${r.childTable}.${r.childCsvCol} → ${r.parentTable}.${r.parentCsvCol}`);
    }
  }

  console.log('\n✓ Sample written to: ' + csvDir);
  console.log('  Run: npm run dataset:import -- ' + datasetKey);
}

main();
