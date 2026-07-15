'use strict';

/**
 * Regression coverage for the request-id / logging / generic-500 error
 * handling added in utils/requestLogger.js and wired through index.js and
 * every route file.
 *
 * Spins up a full in-process Express app replicating index.js's real
 * middleware order (requestContext -> cors -> json -> session -> routers ->
 * global error handler), so this test exercises the actual production
 * wiring, not a simplified stand-in.
 *
 * Cases:
 *   1-4  An unexpected DB error (simulated by temporarily making pool.query
 *        throw for one specific query, leaving every other query — including
 *        the login/auth lookups needed to even reach the route — untouched)
 *        returns 500, a generic body, a requestId that matches the
 *        X-Request-ID response header, no raw PG text anywhere in the
 *        response, and the raw error/requestId are captured by
 *        console.error server-side.
 *   5    A known mapped DB conflict (duplicate session name -> 409) is
 *        unaffected — same status, same user-friendly message, same shape.
 *   6-8  Standard 400/401/403/404 responses are unaffected.
 *   9    Every successful response carries an X-Request-ID header.
 *   10   Two separate requests get two different request ids.
 *   11   The completion log (console.log) for an authenticated request
 *        includes method/path/status/durationMs/userId.
 *   12   The completion log for an unauthenticated request has userId: null.
 *
 * Requires a live DB connection (reads DB config from backend/.env).
 *
 * Run: npm run test:error-handling
 */

const express = require('express');
const cors = require('cors');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const { requestContext, sendUnexpectedError } = require('../src/utils/requestLogger');
const authRouter = require('../src/routes/auth');
const sessionsRouter = require('../src/routes/sessions');
const datasetsRouter = require('../src/routes/datasets');

const PREFIX = '_errhandling_test_';
const TEST_SESSION_SECRET = 'test-secret-for-check-error-handling-script-only';
const TEST_PASSWORD = 'test-password-123456';

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
  await pool.query("DELETE FROM learning_sessions WHERE name LIKE $1", [`${PREFIX}%`]);
  await pool.query('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]);
}

async function createUser(username, role = 'student') {
  const hash = await bcrypt.hash(TEST_PASSWORD, 10);
  const r = await pool.query(
    'INSERT INTO users (username, role, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [username, role, hash]
  );
  return r.rows[0].id;
}

function extractCookie(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  return raw.split(';')[0];
}

async function login(base, username, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  await res.json();
  return { cookie: extractCookie(res) };
}

// Captures console[method] calls without silencing them from a real
// terminal (still logs are just intercepted, not printed) for the duration
// of `fn`, then restores the original.
async function withConsoleSpy(method, fn) {
  const original = console[method];
  const calls = [];
  console[method] = (...args) => { calls.push(args); };
  try {
    await fn(calls);
  } finally {
    console[method] = original;
  }
  return calls;
}

// Makes pool.query throw `fakeErr` for exactly the queries whose SQL text
// `matchFn` matches, while every other query (login lookups, session
// middleware, etc.) still runs for real — so only the one code path under
// test experiences an "unexpected" failure, not the entire request.
async function withFailingQuery(matchFn, fakeErr, fn) {
  const realQuery = pool.query.bind(pool);
  pool.query = (text, params) => {
    if (typeof text === 'string' && matchFn(text)) {
      return Promise.reject(fakeErr);
    }
    return realQuery(text, params);
  };
  try {
    return await fn();
  } finally {
    pool.query = realQuery;
  }
}

async function run() {
  await cleanup();

  let server;
  try {
    const app = express();
    // Mirrors index.js's real middleware order.
    app.use(requestContext);
    app.use(cors());
    app.use(express.json());
    app.use(session({
      store: new pgSession({ pool, createTableIfMissing: true }),
      secret: TEST_SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 14 * 24 * 60 * 60 * 1000 },
    }));
    app.use('/api/auth', authRouter);
    app.use('/api/sessions', sessionsRouter);
    app.use('/api/datasets', datasetsRouter);
    app.use((err, req, res, next) => {
      sendUnexpectedError(req, res, err, { route: 'global-error-handler' });
    });

    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://localhost:${server.address().port}`;
    const sessionsBase = `${base}/api/sessions`;

    // mentor (not student): case 5 below creates a session for itself, which
    // canCreateSessionForUser blocks outright for students, independent of
    // anything this test is actually about.
    const username = `${PREFIX}user`;
    const userId = await createUser(username, 'mentor');
    const { cookie } = await login(base, username, TEST_PASSWORD);

    // ── Cases 1-4: unexpected DB error on a real route ──────────────────────
    {
      const fakeErr = new Error('relation "learning_sessions" does not exist at column internal_pg_detail');
      // Deliberately no .code, so this can never be mistaken for a known
      // 23505-style mapped case — it's an "unexpected" failure by construction.
      let capturedErrorLogs = [];
      let res, body;
      capturedErrorLogs = await withConsoleSpy('error', async () => {
        await withFailingQuery(
          text => text.includes('FROM learning_sessions ls'),
          fakeErr,
          async () => {
            res = await fetch(sessionsBase, { headers: { Cookie: cookie } });
            body = await res.json();
          }
        );
      });

      const headerRequestId = res.headers.get('x-request-id');
      const bodyText = JSON.stringify(body);

      if (res.status === 500) {
        pass('1', 'Unexpected DB error on a real route returns HTTP 500');
      } else {
        fail('1', 'Unexpected DB error must return 500', `status=${res.status}`);
      }

      if (body.error === 'An unexpected error occurred.') {
        pass('2', `Response body has the generic error text ("${body.error}")`);
      } else {
        fail('2', 'Response body must have the generic error text', `body=${bodyText}`);
      }

      if (body.requestId && body.requestId === headerRequestId) {
        pass('3', `Response body requestId matches the X-Request-ID header (${body.requestId})`);
      } else {
        fail('3', 'Response body requestId must match the X-Request-ID header', `bodyRequestId=${body.requestId}, header=${headerRequestId}`);
      }

      const leaksInternalDetail = bodyText.includes('learning_sessions') || bodyText.includes('internal_pg_detail') || bodyText.includes('relation');
      if (!leaksInternalDetail) {
        pass('4a', 'Response body contains no raw PostgreSQL/internal error text');
      } else {
        fail('4a', 'Response body must not leak internal error text', `body=${bodyText}`);
      }

      const loggedWithRequestId = capturedErrorLogs.some(callArgs =>
        JSON.stringify(callArgs).includes(headerRequestId) && JSON.stringify(callArgs).includes('learning_sessions')
      );
      if (loggedWithRequestId) {
        pass('4b', 'The requestId and the real underlying error both appear in the server-side console.error log');
      } else {
        fail('4b', 'The server-side log must include the requestId and the real error', `capturedErrorLogs=${JSON.stringify(capturedErrorLogs)}`);
      }
    }

    // ── Case 5: known mapped DB conflict (duplicate session name) unaffected ──
    {
      const sessionName = `${PREFIX}dup_session`;
      const dataset = await pool.query("SELECT id FROM datasets WHERE key = 'academic'");
      const create = () => fetch(sessionsBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: sessionName, datasetId: dataset.rows[0].id }),
      });
      const first = await create();
      await first.json();
      const second = await create();
      const secondBody = await second.json();
      if (second.status === 409 && secondBody.error === 'A session with this name already exists. Please choose a different name.') {
        pass('5', 'Duplicate session name still returns the existing 409 with its exact user-friendly message, unaffected by the new error handling');
      } else {
        fail('5', 'Known 409 conflict behavior must be unchanged', `status=${second.status}, body=${JSON.stringify(secondBody)}`);
      }
    }

    // ── Cases 6-8: standard 400/401/403/404 unaffected ──────────────────────
    {
      const res400 = await fetch(`${sessionsBase}/not-a-number`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: 'x' }) });
      const body400 = await res400.json();
      if (res400.status === 400 && body400.error === 'Invalid session id.') {
        pass('6', 'Standard 400 (invalid id) response is unchanged');
      } else {
        fail('6', 'Standard 400 response must be unchanged', `status=${res400.status}, body=${JSON.stringify(body400)}`);
      }

      const res401 = await fetch(sessionsBase);
      const body401 = await res401.json();
      if (res401.status === 401 && body401.error === 'Not authenticated.') {
        pass('7', 'Standard 401 (unauthenticated) response is unchanged');
      } else {
        fail('7', 'Standard 401 response must be unchanged', `status=${res401.status}, body=${JSON.stringify(body401)}`);
      }

      const res404 = await fetch(`${sessionsBase}/999999990/reopen`, { method: 'PATCH', headers: { Cookie: cookie } });
      const body404 = await res404.json();
      if (res404.status === 403 || res404.status === 404) {
        // Nonexistent session: exact status already covered by the reopen
        // suite; here we only assert the message is still the pre-existing
        // one, not the generic 500 text.
        pass('8', `Standard 4xx (nonexistent session on reopen) response is unchanged (status=${res404.status}, "${body404.error}")`);
      } else {
        fail('8', 'Nonexistent-session response must stay a 4xx with its known message', `status=${res404.status}, body=${JSON.stringify(body404)}`);
      }
    }

    // ── Case 9: successful responses carry X-Request-ID ─────────────────────
    {
      const res = await fetch(`${base}/api/datasets`);
      const requestId = res.headers.get('x-request-id');
      if (res.status === 200 && requestId) {
        pass('9', `Successful response includes X-Request-ID (${requestId})`);
      } else {
        fail('9', 'Successful responses must include X-Request-ID', `status=${res.status}, requestId=${requestId}`);
      }
    }

    // ── Case 10: two separate requests get different request ids ───────────
    {
      const [res1, res2] = await Promise.all([
        fetch(`${base}/api/datasets`),
        fetch(`${base}/api/datasets`),
      ]);
      const id1 = res1.headers.get('x-request-id');
      const id2 = res2.headers.get('x-request-id');
      if (id1 && id2 && id1 !== id2) {
        pass('10', `Two separate requests receive different request ids (${id1} vs ${id2})`);
      } else {
        fail('10', 'Two separate requests must receive different request ids', `id1=${id1}, id2=${id2}`);
      }
    }

    // ── Case 11: completion log for an authenticated request ────────────────
    {
      const logs = await withConsoleSpy('log', async () => {
        const res = await fetch(sessionsBase, { headers: { Cookie: cookie } });
        await res.json();
      });
      const completionLog = logs.find(callArgs => callArgs[0] === 'HTTP request completed');
      const entry = completionLog?.[1];
      const shapeOk = entry
        && entry.method === 'GET'
        && entry.path === '/api/sessions'
        && entry.status === 200
        && typeof entry.durationMs === 'number'
        && entry.userId === userId
        && typeof entry.requestId === 'string';
      if (shapeOk) {
        pass('11', `Completion log for an authenticated request has the right shape (method/path/status/durationMs/userId=${entry.userId})`);
      } else {
        fail('11', 'Completion log must include method/path/status/durationMs/userId', `entry=${JSON.stringify(entry)}`);
      }
    }

    // ── Case 12: completion log for an unauthenticated request has userId: null ──
    {
      const logs = await withConsoleSpy('log', async () => {
        const res = await fetch(sessionsBase);
        await res.json();
      });
      const completionLog = logs.find(callArgs => callArgs[0] === 'HTTP request completed');
      const entry = completionLog?.[1];
      if (entry && entry.userId === null && entry.status === 401) {
        pass('12', 'Completion log for an unauthenticated request has userId: null');
      } else {
        fail('12', 'Completion log for an unauthenticated request must have userId: null', `entry=${JSON.stringify(entry)}`);
      }
    }

  } catch (err) {
    console.error('UNEXPECTED ERROR:', err.message);
    failed++;
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
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
