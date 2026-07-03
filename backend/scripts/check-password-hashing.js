'use strict';

/**
 * users.password_hash migration + set-user-password.js verification script.
 *
 * Runs initDb() twice to prove the migration is idempotent, checks the
 * column's shape directly against information_schema, verifies bcryptjs
 * hash/compare behavior, and exercises the real set-user-password.js CLI
 * script as a child process (not a reimplementation) against a temporary
 * test user — confirming other users are left untouched.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:password-hashing
 */

const path = require('path');
const { execFileSync } = require('child_process');
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const initDb = require('../src/initDb');

const SET_PASSWORD_SCRIPT = path.resolve(__dirname, 'set-user-password.js');
const PREFIX = '_pwhash_test_';

let passed = 0;
let failed = 0;

function pass(id, name) {
  console.log(`[${id}] PASS — ${name}`);
  passed++;
}

function fail(id, name, detail) {
  console.log(`[${id}] FAIL — ${name}: ${detail}`);
  failed++;
}

async function cleanup() {
  await pool.query('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
}

function runScript(args) {
  try {
    const stdout = execFileSync('node', [SET_PASSWORD_SCRIPT, ...args], { encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' };
  }
}

async function run() {
  await cleanup();

  try {
    // ── Case 1: initDb() runs twice without error ─────────────────────────────
    try {
      await initDb();
      await initDb();
      pass('01', 'initDb() runs twice without throwing (password_hash migration is idempotent)');
    } catch (err) {
      fail('01', 'initDb() must be safely re-runnable', err.message);
    }

    // ── Case 2: column shape — exists, nullable, no default ───────────────────
    const colRes = await pool.query(`
      SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'password_hash'
    `);
    if (colRes.rows.length === 1) {
      pass('02', 'users.password_hash column exists');
    } else {
      fail('02', 'users.password_hash column must exist', `found ${colRes.rows.length} matching columns`);
    }
    if (colRes.rows[0]?.is_nullable === 'YES') {
      pass('03', 'users.password_hash is nullable');
    } else {
      fail('03', 'users.password_hash must be nullable', `is_nullable=${colRes.rows[0]?.is_nullable}`);
    }
    if (colRes.rows[0]?.column_default === null) {
      pass('04', 'users.password_hash has no default value');
    } else {
      fail('04', 'users.password_hash must have no default', `column_default=${colRes.rows[0]?.column_default}`);
    }

    // ── Case 5: bcryptjs hash/compare — correct password passes ──────────────
    const testHash = await bcrypt.hash('correct-horse-battery', 10);
    const correctMatches = await bcrypt.compare('correct-horse-battery', testHash);
    if (correctMatches) {
      pass('05', 'bcryptjs: correct password matches its hash');
    } else {
      fail('05', 'bcryptjs: correct password must match its hash', 'compare returned false');
    }

    // ── Case 6: bcryptjs hash/compare — wrong password fails ──────────────────
    const wrongMatches = await bcrypt.compare('totally-different-password', testHash);
    if (!wrongMatches) {
      pass('06', 'bcryptjs: wrong password does not match the hash');
    } else {
      fail('06', 'bcryptjs: wrong password must not match the hash', 'compare returned true');
    }

    // ── Case 7: set-user-password.js sets a password for a real (temp) user ──
    const created = await pool.query(
      'INSERT INTO users (username) VALUES ($1) RETURNING id',
      [`${PREFIX}target`]
    );
    const targetUserId = created.rows[0].id;

    // Snapshot every other user's password_hash before running the script.
    const beforeOthers = await pool.query(
      "SELECT id, password_hash FROM users WHERE username NOT LIKE $1",
      [`${PREFIX}%`]
    );

    const result = runScript([`${PREFIX}target`, 'a-valid-password-123']);
    if (result.code === 0 && !result.stdout.includes('a-valid-password-123')) {
      const row = await pool.query('SELECT password_hash FROM users WHERE id = $1', [targetUserId]);
      const stored = row.rows[0].password_hash;
      const compareOk = stored && await bcrypt.compare('a-valid-password-123', stored);
      if (compareOk && !result.stdout.includes(stored)) {
        pass('07', 'set-user-password.js sets a working password hash and never prints the raw password or hash');
      } else {
        fail('07', 'set-user-password.js must store a hash that verifies the given password', `stored=${stored ? '(present)' : '(null)'}, compareOk=${compareOk}`);
      }
    } else {
      fail('07', 'set-user-password.js must succeed (exit 0) for a valid existing user without leaking the password', `code=${result.code}, stdout=${result.stdout}`);
    }

    // ── Case 8: other users are not modified ──────────────────────────────────
    const afterOthers = await pool.query(
      "SELECT id, password_hash FROM users WHERE username NOT LIKE $1",
      [`${PREFIX}%`]
    );
    const beforeMap = Object.fromEntries(beforeOthers.rows.map(r => [r.id, r.password_hash]));
    const unchanged = afterOthers.rows.every(r => beforeMap[r.id] === r.password_hash);
    if (unchanged && afterOthers.rows.length === beforeOthers.rows.length) {
      pass('08', `All ${afterOthers.rows.length} other user(s) left untouched`);
    } else {
      fail('08', 'Other users must not be modified by set-user-password.js', 'password_hash changed for at least one unrelated user');
    }

    // ── Case 9: missing username argument is rejected ─────────────────────────
    {
      const r = runScript([]);
      if (r.code !== 0 && !r.stdout.includes('a-valid-password-123')) {
        pass('09', 'Missing username argument exits non-zero with a clear error');
      } else {
        fail('09', 'Missing username must be rejected', `code=${r.code}`);
      }
    }

    // ── Case 10: missing password argument is rejected ────────────────────────
    {
      const r = runScript([`${PREFIX}target`]);
      if (r.code !== 0) {
        pass('10', 'Missing password argument exits non-zero with a clear error');
      } else {
        fail('10', 'Missing password must be rejected', `code=${r.code}`);
      }
    }

    // ── Case 11: too-short password is rejected ───────────────────────────────
    {
      const r = runScript([`${PREFIX}target`, 'short']);
      if (r.code !== 0 && !r.stdout.includes('short')) {
        pass('11', 'Password shorter than 8 characters exits non-zero with a clear error');
      } else {
        fail('11', 'Too-short password must be rejected', `code=${r.code}`);
      }
    }

    // ── Case 12: nonexistent username is rejected ─────────────────────────────
    {
      const r = runScript([`${PREFIX}does_not_exist`, 'a-valid-password-123']);
      if (r.code !== 0) {
        pass('12', 'Nonexistent username exits non-zero with a clear error');
      } else {
        fail('12', 'Nonexistent username must be rejected', `code=${r.code}`);
      }
    }

  } catch (err) {
    console.error('UNEXPECTED ERROR:', err.message);
    failed++;
  } finally {
    await cleanup();
    await pool.end();
  }

  console.log('');
  console.log(`Result: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Unhandled error:', err.message);
  process.exit(1);
});
