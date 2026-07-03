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

function readCSV(filePath) {
  let text = fs.readFileSync(filePath, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
                    .split('\n').filter(l => l.trim());
  return lines.map(parseCSVLine);
}

// ── Header detection ──────────────────────────────────────────────────────────

function looksLikeHeader(row) {
  const identRe    = /^[a-zA-Z_][a-zA-Z0-9_ ]*$/;
  const textFields = row.filter(f => f.trim() !== '');
  if (textFields.length === 0) return false;
  const identCount = textFields.filter(f => identRe.test(f.trim())).length;
  return identCount / textFields.length > 0.5;
}

// ── Type inference ────────────────────────────────────────────────────────────

const INTEGER_RE  = /^-?\d+$/;
const NUMERIC_RE  = /^-?\d*\.?\d+([eE][+-]?\d+)?$/;
const DATE_RE     = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = [
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/,
  /^\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}/,
];

const PG_INT_MAX = 2147483647; // 2^31 - 1

function inferType(values) {
  const nonEmpty = values.filter(v => v !== '');
  if (nonEmpty.length === 0) return 'TEXT';
  if (nonEmpty.every(v => INTEGER_RE.test(v))) {
    // Upgrade to BIGINT if any sampled value exceeds PostgreSQL INTEGER range.
    // Note: only the first 500 rows are sampled; overflow in later rows won't be caught.
    if (nonEmpty.some(v => Math.abs(parseInt(v, 10)) > PG_INT_MAX)) return 'BIGINT';
    return 'INTEGER';
  }
  if (nonEmpty.every(v => NUMERIC_RE.test(v)))                return 'NUMERIC';
  if (nonEmpty.every(v => DATETIME_RE.some(r => r.test(v)))) return 'TIMESTAMP';
  if (nonEmpty.every(v => DATE_RE.test(v) || DATETIME_RE.some(r => r.test(v)))) {
    if (nonEmpty.every(v => DATE_RE.test(v))) return 'DATE';
    return 'TIMESTAMP';
  }
  return 'TEXT';
}

// ── Singularization ───────────────────────────────────────────────────────────
// Converts common English plural table names to singular for PK/FK name matching.

const SINGULAR_IRREGULARS = {
  people: 'person', children: 'child', men: 'man', women: 'woman',
  geese: 'goose', teeth: 'tooth', feet: 'foot', mice: 'mouse', oxen: 'ox',
};

function singularize(word) {
  const w = word.toLowerCase();
  if (SINGULAR_IRREGULARS[w]) return SINGULAR_IRREGULARS[w];
  if (w.endsWith('ies'))  return w.slice(0, -3) + 'y'; // countries → country
  if (w.endsWith('ches')) return w.slice(0, -2);        // watches → watch
  if (w.endsWith('shes')) return w.slice(0, -2);        // bushes → bush
  if (w.endsWith('ses'))  return w.slice(0, -2);        // buses → bus
  if (w.endsWith('xes'))  return w.slice(0, -2);        // boxes → box
  if (w.endsWith('zes'))  return w.slice(0, -2);        // buzzes → buzz
  if (w.endsWith('ves'))  return w.slice(0, -3) + 'f'; // halves → half
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1); // regions → region
  return w;
}

// Returns all candidate plural forms for a base word, for FK table lookup.
const PLURAL_IRREGULARS = {
  person: 'people', child: 'children', man: 'men', woman: 'women',
  goose: 'geese', tooth: 'teeth', foot: 'feet', mouse: 'mice', ox: 'oxen',
};

function pluralCandidates(base) {
  const b = base.toLowerCase();
  const candidates = [
    b,
    b + 's',
    b + 'es',
    b.replace(/y$/, 'ies'),
    b.replace(/f$/, 'ves'),
  ];
  if (PLURAL_IRREGULARS[b]) candidates.push(PLURAL_IRREGULARS[b]);
  return candidates;
}

// Whether a column is the table's own entity ID column (PK candidate, not FK).
// e.g., table='continents', col='continent_id' → true (singularize(continents)=continent)
// e.g., table='countries',  col='country_id'  → true
function isOwnEntityIdCol(tableName, colName) {
  const singular = singularize(tableName);
  return colName === singular + '_id' || colName === tableName + '_id';
}

// ── FK target inference ───────────────────────────────────────────────────────
// Returns the parent table name, or null if not inferrable or would be a self-reference.

function inferFKTable(tableName, colName, allTableNames) {
  if (!colName.endsWith('_id')) return null;
  if (isOwnEntityIdCol(tableName, colName)) return null; // own entity ID → not a FK
  const base = colName.slice(0, -3);
  for (const candidate of pluralCandidates(base)) {
    if (allTableNames.includes(candidate) && candidate !== tableName) return candidate;
  }
  return null;
}

// ── Topological sort (FK-aware load order) ────────────────────────────────────

function topologicalSort(tableNames, deps) {
  const visited = new Set();
  const order   = [];
  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    for (const dep of (deps[name] || [])) visit(dep);
    order.push(name);
  }
  for (const t of tableNames) visit(t);
  return order;
}

// ── Root table inference ──────────────────────────────────────────────────────
// Picks the table with the most incoming FK references (highest in-degree) as root
// for consistent sampling. Tie-broken by out-degree (more connected = better root).

function inferRootTable(tableNames, fkTargets) {
  const inDegree  = {};
  const outDegree = {};
  for (const t of tableNames) { inDegree[t] = 0; outDegree[t] = 0; }

  for (const [child, parents] of Object.entries(fkTargets)) {
    const unique = new Set(parents);
    for (const parent of unique) {
      inDegree[parent]  = (inDegree[parent]  || 0) + 1;
      outDegree[child] = (outDegree[child] || 0) + 1;
    }
  }

  const candidates = tableNames.filter(t => inDegree[t] > 0);
  if (candidates.length === 0) return null;

  candidates.sort((a, b) =>
    inDegree[b] !== inDegree[a]
      ? inDegree[b] - inDegree[a]
      : outDegree[b] - outDegree[a]
  );

  return candidates[0];
}

// ── Column name generation for headerless CSVs ────────────────────────────────

function makeColName(i) {
  return `col_${i + 1}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const args       = process.argv.slice(2);
  const datasetKey = args.find(a => !a.startsWith('--'));
  const force      = args.includes('--force');

  if (!datasetKey) {
    console.error('Usage: node generate-dataset-config.js <datasetKey> [--force]');
    console.error('Example: node generate-dataset-config.js movies');
    process.exit(1);
  }

  const datasetDir = path.join(__dirname, `../src/data/datasets/${datasetKey}`);
  const rawDir     = path.join(datasetDir, 'raw');
  const outPath    = path.join(datasetDir, 'dataset.config.json');

  if (!fs.existsSync(rawDir)) {
    console.error(`raw/ directory not found: ${rawDir}`);
    console.error(`Place source CSV files in: ${rawDir}`);
    process.exit(1);
  }

  if (fs.existsSync(outPath) && !force) {
    console.error(`dataset.config.json already exists. Use --force to overwrite.`);
    console.error(`Path: ${outPath}`);
    process.exit(1);
  }

  const csvFiles = fs.readdirSync(rawDir)
    .filter(f => f.endsWith('.csv'))
    .sort();

  if (csvFiles.length === 0) {
    console.error(`No CSV files found in ${rawDir}`);
    process.exit(1);
  }

  const warnings = [];

  // ── Parse each CSV ───────────────────────────────────────────────────────
  const tableSpecs = {};
  const tableNames = [];

  for (const csvFile of csvFiles) {
    const tableName = csvFile.replace(/\.csv$/, '');
    tableNames.push(tableName);

    const csvPath = path.join(rawDir, csvFile);
    const allRows = readCSV(csvPath);

    if (allRows.length === 0) {
      warnings.push(`${csvFile}: file is empty — skipping`);
      continue;
    }

    const hasHeader = looksLikeHeader(allRows[0]);
    const headers   = hasHeader
      ? allRows[0].map(h => h.trim())
      : allRows[0].map((_, i) => makeColName(i));
    const dataRows  = hasHeader ? allRows.slice(1) : allRows;

    if (!hasHeader) {
      warnings.push(`${csvFile}: no header row detected — using generated column names (${headers.join(', ')}). Rename them in the generated config.`);
    }

    const sample = dataRows.slice(0, 500);
    tableSpecs[tableName] = { csvFile, hasHeader, headers, dataRows, sample };
  }

  // ── Infer column metadata ─────────────────────────────────────────────────
  // type and nullable come from the sample (first 500 rows).
  // colUnique and hasEmpty are checked across ALL data rows for accurate PK detection.

  for (const tableName of tableNames) {
    const spec = tableSpecs[tableName];
    if (!spec) continue;

    const { headers, dataRows, sample } = spec;
    const columns = [];

    for (let i = 0; i < headers.length; i++) {
      const colName    = headers[i];
      const sampleVals = sample.map(row => (row[i] ?? '').trim());
      const allVals    = dataRows.map(row => (row[i] ?? '').trim());
      const nonEmpty   = allVals.filter(v => v !== '');

      const type      = inferType(sampleVals);
      const nullable  = sampleVals.some(v => v === '');
      const colUnique = nonEmpty.length > 0 && new Set(nonEmpty).size === nonEmpty.length;
      const hasEmpty  = allVals.some(v => v === '');

      columns.push({ name: colName, type, nullable, colUnique, hasEmpty });
    }

    spec.columns = columns;
  }

  // ── PK detection ──────────────────────────────────────────────────────────
  // Priority 1: column named 'id'                       — unique, non-null, INTEGER
  // Priority 2: column '<singularize(tableName)>_id'    — unique, non-null, INTEGER
  //             prevents wrong self-referencing FK inference
  // Priority 3: column 'index'                         — unique, non-null (fallback)
  //             for bridge/fact tables without a natural entity ID

  const pkMap = {}; // tableName → colName | null

  for (const tableName of tableNames) {
    const spec = tableSpecs[tableName];
    if (!spec) { pkMap[tableName] = null; continue; }

    let pkCol = null;

    for (const col of spec.columns) {
      if (col.hasEmpty || !col.colUnique) continue;        // must be unique and fully populated
      if (!pkCol && col.name === 'id' && col.type === 'INTEGER') {
        pkCol = col.name;                                  // Priority 1
      }
      if (!pkCol && isOwnEntityIdCol(tableName, col.name) && col.type === 'INTEGER') {
        pkCol = col.name;                                  // Priority 2
      }
    }

    // Priority 3: 'index' fallback for tables without a natural entity ID
    if (!pkCol) {
      const idxCol = spec.columns.find(c => c.name === 'index');
      if (idxCol && !idxCol.hasEmpty && idxCol.colUnique) {
        pkCol = 'index';
      }
    }

    pkMap[tableName] = pkCol;

    if (!pkCol) {
      warnings.push(`${tableName}: no primary key detected — add "primaryKey": true manually`);
      // Extra hint if there's an entity ID column that failed uniqueness
      for (const col of spec.columns) {
        if (isOwnEntityIdCol(tableName, col.name) && col.type === 'INTEGER') {
          warnings.push(`  ${tableName}.${col.name}: looks like entity ID but ${col.hasEmpty ? 'has empty values' : 'is not unique'} — verify data`);
        }
      }
    }
  }

  // ── FK inference ──────────────────────────────────────────────────────────
  // For each *_id column that is not the table's own PK:
  //   - skip if it matches the table's own entity ID pattern (avoids self-references)
  //   - match to a parent table via singular/plural name candidates
  //   - reference the parent's detected PK column

  const fkMap     = {}; // tableName → { colName → parentTableName }
  const fkTargets = {}; // tableName → [parentTableName, ...] (for topo sort + root inference)

  for (const tableName of tableNames) {
    const spec = tableSpecs[tableName];
    if (!spec) continue;
    fkMap[tableName]     = {};
    fkTargets[tableName] = [];

    for (const col of spec.columns) {
      if (col.name === pkMap[tableName]) continue; // own PK is never a FK

      const parentTable = inferFKTable(tableName, col.name, tableNames);

      if (parentTable) {
        const parentPK = pkMap[parentTable];
        if (parentPK) {
          fkMap[tableName][col.name] = parentTable;
          fkTargets[tableName].push(parentTable);
        } else {
          warnings.push(`${tableName}.${col.name}: matched parent "${parentTable}" has no detected PK — FK not added; set manually`);
        }
      } else if (col.name.endsWith('_id') && !isOwnEntityIdCol(tableName, col.name)) {
        warnings.push(`${tableName}.${col.name}: ends with _id but no matching table found — add FK manually if needed`);
      }
    }
  }

  // ── Load order ────────────────────────────────────────────────────────────
  const loadOrder = topologicalSort(tableNames, fkTargets);

  // ── sampleOptions ─────────────────────────────────────────────────────────
  const hasFKs    = Object.values(fkMap).some(fks => Object.keys(fks).length > 0);
  const rootTable = hasFKs ? inferRootTable(tableNames, fkTargets) : null;

  let sampleOptions;
  if (!hasFKs) {
    sampleOptions = { mode: 'preserve' };
  } else if (rootTable) {
    sampleOptions = { mode: 'consistent', rootTable, limit: 100 };
  } else {
    sampleOptions = { mode: 'preserve' };
    warnings.push('sampleOptions: no obvious root table found — defaulted to preserve mode. Set sampleOptions.rootTable manually for consistent sampling.');
  }

  // ── Build config ──────────────────────────────────────────────────────────
  const displayName = datasetKey.charAt(0).toUpperCase() + datasetKey.slice(1);

  const tables = {};
  for (const tableName of tableNames) {
    const spec = tableSpecs[tableName];
    if (!spec) continue;

    const pkColName = pkMap[tableName];

    const columns = spec.columns.map(col => {
      const entry = { name: col.name, type: col.type };
      if (col.name === pkColName) {
        entry.primaryKey = true;
      } else {
        entry.nullable = col.nullable;
        const parentTable = fkMap[tableName]?.[col.name];
        if (parentTable) {
          entry.references = { table: parentTable, column: pkMap[parentTable] };
        }
      }
      return entry;
    });

    tables[tableName] = { csvFile: spec.csvFile, columns };
  }

  const config = {
    key:         datasetKey,
    name:        displayName,
    schemaName:  datasetKey,
    description: `${displayName} dataset`,
    type:        'official',
    sampleOptions,
    loadOrder,
    tables,
  };

  // ── Write config ──────────────────────────────────────────────────────────
  fs.writeFileSync(outPath, JSON.stringify(config, null, 2) + '\n');

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`\nDataset config generator — ${displayName} (${datasetKey})\n`);
  console.log(`Source : ${rawDir}`);
  console.log(`Output : ${outPath}\n`);

  console.log('Detected tables:');
  for (const tableName of tableNames) {
    const spec = tableSpecs[tableName];
    if (!spec) continue;
    const pkColName = pkMap[tableName] || '(none)';
    const pkNote    = !pkMap[tableName] ? '' :
                      pkColName === 'index' ? ' [fallback]' :
                      pkColName === 'id'    ? '' : ' [entity ID]';
    console.log(`  ${tableName} — ${spec.dataRows.length} rows, ${spec.columns.length} cols, PK: ${pkColName}${pkNote}`);
    for (const col of spec.columns) {
      const isPK        = col.name === pkMap[tableName];
      const parentTable = fkMap[tableName]?.[col.name];
      const parentPK    = parentTable ? pkMap[parentTable] : null;
      const flags = [
        isPK                         ? 'PK'                                    : null,
        !isPK && !col.nullable        ? 'NOT NULL'                               : null,
        parentTable && parentPK       ? `→ ${parentTable}(${parentPK})`         : null,
        parentTable && !parentPK      ? `→ ${parentTable} (no PK, FK skipped)`  : null,
      ].filter(Boolean).join(', ');
      console.log(`    ${col.name.padEnd(22)} ${col.type.padEnd(12)} ${flags}`);
    }
  }

  console.log(`\nLoad order: ${loadOrder.join(' → ')}`);

  const fkLines = [];
  for (const [tbl, fks] of Object.entries(fkMap)) {
    for (const [col, parent] of Object.entries(fks)) {
      fkLines.push(`  ${tbl}.${col} → ${parent}(${pkMap[parent]})`);
    }
  }
  if (fkLines.length > 0) {
    console.log('\nInferred FKs:');
    fkLines.forEach(l => console.log(l));
  } else {
    console.log('\nInferred FKs: none');
  }

  if (rootTable) {
    console.log(`\nsampleOptions: consistent — rootTable: ${rootTable}, limit: ${sampleOptions.limit}`);
  } else {
    console.log(`\nsampleOptions: preserve — ${hasFKs ? 'no obvious root table' : 'no FK relationships'}`);
  }

  if (warnings.length > 0) {
    console.log('\nWarnings:');
    warnings.forEach(w => console.log(`  ⚠  ${w}`));
  }

  console.log(`\n✓ Config written to: ${outPath}`);
  console.log('  Review before running: npm run dataset:import -- ' + datasetKey);
}

main();
