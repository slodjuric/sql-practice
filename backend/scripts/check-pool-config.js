'use strict';

/**
 * Small, focused regression coverage for the explicit connection-pool
 * configuration (backend/src/db.js) and the pool-acquisition-failure
 * classification it enables (backend/src/utils/queryRunner.js).
 *
 * Cases:
 *   1-3  The already-running pool (this process's require of ../src/db,
 *        with no DB_POOL_MAX/DB_CONNECTION_TIMEOUT_MS/DB_IDLE_TIMEOUT_MS set
 *        in backend/.env) reflects the documented defaults: max=10,
 *        connectionTimeoutMillis=5000, idleTimeoutMillis=30000.
 *   4    The env vars actually override those defaults — verified via a
 *        separate child process (module-level `pool` is a singleton, so
 *        re-requiring db.js in this same process would just return the
 *        already-configured instance).
 *   5-6  executeUserQuery/executeSolutionQuery both surface a pool-connect
 *        failure as a generic, marked error (isPoolAcquisitionFailure) with
 *        no raw pg-pool internal text — reproduced deterministically by
 *        monkey-patching pool.connect, not by actually exhausting the pool.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:pool-config
 */

const path = require('path');
const { execFileSync } = require('child_process');
const pool = require('../src/db');
const { executeUserQuery, executeSolutionQuery } = require('../src/utils/queryRunner');

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

async function run() {
  try {
    // ── Cases 1-3: defaults on the real, already-running pool ──────────────
    if (pool.options.max === 10) {
      pass('1', `Pool max defaults to 10 (got ${pool.options.max})`);
    } else {
      fail('1', 'Pool max must default to 10', `got ${pool.options.max}`);
    }

    if (pool.options.connectionTimeoutMillis === 5000) {
      pass('2', `Pool connectionTimeoutMillis defaults to 5000 (got ${pool.options.connectionTimeoutMillis})`);
    } else {
      fail('2', 'Pool connectionTimeoutMillis must default to 5000', `got ${pool.options.connectionTimeoutMillis}`);
    }

    if (pool.options.idleTimeoutMillis === 30000) {
      pass('3', `Pool idleTimeoutMillis defaults to 30000 (got ${pool.options.idleTimeoutMillis})`);
    } else {
      fail('3', 'Pool idleTimeoutMillis must default to 30000', `got ${pool.options.idleTimeoutMillis}`);
    }

    // ── Case 4: env vars override the defaults (fresh child process) ───────
    {
      const inline = `
        const p = require('${path.join(__dirname, '..', 'src', 'db').replace(/\\/g, '\\\\')}');
        console.log(JSON.stringify({ max: p.options.max, connectionTimeoutMillis: p.options.connectionTimeoutMillis, idleTimeoutMillis: p.options.idleTimeoutMillis }));
        p.end();
      `;
      const out = execFileSync(process.execPath, ['-e', inline], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, DB_POOL_MAX: '3', DB_CONNECTION_TIMEOUT_MS: '1234', DB_IDLE_TIMEOUT_MS: '9999' },
        encoding: 'utf8',
      });
      const observed = JSON.parse(out.trim().split('\n').pop());
      if (observed.max === 3 && observed.connectionTimeoutMillis === 1234 && observed.idleTimeoutMillis === 9999) {
        pass('4', `DB_POOL_MAX/DB_CONNECTION_TIMEOUT_MS/DB_IDLE_TIMEOUT_MS env vars override the defaults (${JSON.stringify(observed)})`);
      } else {
        fail('4', 'Env vars must override the pool defaults', `observed=${JSON.stringify(observed)}`);
      }
    }

    // ── Cases 5-6: pool-connect failure is classified, not leaked raw ──────
    {
      const realConnect = pool.connect.bind(pool);
      pool.connect = () => Promise.reject(new Error('timeout exceeded when trying to connect'));
      try {
        try {
          await executeUserQuery('SELECT 1', 'academic');
          fail('5', 'executeUserQuery must reject when pool.connect() fails', 'did not throw');
        } catch (err) {
          const clean = err.isPoolAcquisitionFailure === true
            && err.message === 'Unable to acquire a database connection.'
            && !err.message.includes('timeout exceeded when trying to connect');
          if (clean) {
            pass('5', 'executeUserQuery surfaces a pool-connect failure as a generic, marked error (no raw pg-pool text)');
          } else {
            fail('5', 'executeUserQuery must surface a clean, marked pool-acquisition error', `isPoolAcquisitionFailure=${err.isPoolAcquisitionFailure}, message="${err.message}"`);
          }
        }

        try {
          await executeSolutionQuery('SELECT 1', 'academic');
          fail('6', 'executeSolutionQuery must reject when pool.connect() fails', 'did not throw');
        } catch (err) {
          const clean = err.isPoolAcquisitionFailure === true
            && err.message === 'Unable to acquire a database connection.';
          if (clean) {
            pass('6', 'executeSolutionQuery surfaces the same clean, marked pool-acquisition error');
          } else {
            fail('6', 'executeSolutionQuery must surface a clean, marked pool-acquisition error', `isPoolAcquisitionFailure=${err.isPoolAcquisitionFailure}, message="${err.message}"`);
          }
        }
      } finally {
        pool.connect = realConnect;
      }
    }

  } catch (err) {
    console.error('UNEXPECTED ERROR:', err.message);
    failed++;
  } finally {
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
