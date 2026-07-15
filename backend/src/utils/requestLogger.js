'use strict';

const crypto = require('crypto');

// Context keys that must never reach a log line, even if a caller passes
// them in by mistake. Kept as a small, explicit allowlist-by-exclusion
// rather than a generic deep-redaction library, since every call site in
// this codebase only ever passes a handful of known-safe fields (route name,
// sessionId, targetUserId) — this is a guardrail, not the primary defense.
const NEVER_LOG_KEYS = new Set([
  'password', 'newPassword', 'currentPassword', 'password_hash',
  'cookie', 'authorization', 'sessionCookie', 'body', 'sql', 'query',
]);

function safeContext(context = {}) {
  const out = {};
  for (const [key, value] of Object.entries(context)) {
    if (NEVER_LOG_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function currentUserId(req) {
  return req.session?.userId ?? null;
}

// Attaches a per-request correlation id (req.requestId, echoed back as the
// X-Request-ID response header) and logs one structured completion line once
// the response finishes. Registered as the very first middleware in
// index.js — before cors/json/session — so every request gets a request id
// and header, including ones that fail before reaching a route (e.g. a
// malformed JSON body). The completion log's userId read happens inside the
// res.on('finish') callback, which fires only after the full
// middleware/route chain (including express-session) has already run for
// this request — so it reflects the real acting user regardless of where in
// the chain this middleware itself sits.
//
// Always generates a fresh id server-side rather than trusting an incoming
// X-Request-ID header — there is no existing convention in this codebase for
// accepting one, and treating unvalidated client input as a trusted log
// correlation key isn't something to introduce as a side effect of this task.
function requestContext(req, res, next) {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  const startedAt = Date.now();
  // Captured now, before any nested router mounting touches it. Express
  // temporarily strips the mount prefix from req.url/req.path while
  // dispatching into a router mounted with app.use('/api/x', router), and
  // only restores it when that router calls next() — every route here ends
  // the response directly instead, so by the time res.on('finish') fires,
  // req.path would otherwise still reflect that router-relative, stripped
  // value (e.g. '/' instead of '/api/sessions'). req.method is stable
  // throughout, so no need to snapshot that too.
  const requestPath = req.path;

  res.on('finish', () => {
    console.log('HTTP request completed', {
      requestId: req.requestId,
      method: req.method,
      path: requestPath,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      userId: currentUserId(req),
    });
  });

  next();
}

// Pure logging, no response — for the couple of spots (auth.js's
// session.regenerate/session.destroy callbacks) that already return a safe,
// specific message and just need the underlying error recorded server-side.
function logServerError(req, err, context = {}) {
  console.error('Unexpected server error', {
    requestId: req?.requestId ?? null,
    userId: currentUserId(req),
    ...safeContext(context),
    message: err?.message,
    code: err?.code,
    stack: err?.stack,
  });
}

// Logs the full error with request/user correlation, then sends the generic,
// detail-free 500 every "unexpected" route catch block should return.
// `context` is a small route-supplied object (e.g. { route: 'PATCH
// /api/sessions/:id', sessionId }) — never the raw request body/query/headers.
function sendUnexpectedError(req, res, err, context = {}) {
  logServerError(req, err, context);
  res.status(500).json({ error: 'An unexpected error occurred.', requestId: req?.requestId ?? null });
}

// Wraps a transaction ROLLBACK so a failure rolling back can't hide the
// original error that triggered it (and can't skip past the caller's own
// error response either) — logs the rollback failure separately, but always
// returns normally so the caller's catch block can go on to log/respond
// with the real, original error.
async function safeRollback(client, req, context = {}) {
  try {
    await client.query('ROLLBACK');
  } catch (rollbackErr) {
    console.error('Rollback failed after an unexpected error', {
      requestId: req?.requestId ?? null,
      userId: currentUserId(req),
      ...safeContext(context),
      rollbackMessage: rollbackErr?.message,
    });
  }
}

module.exports = { requestContext, sendUnexpectedError, logServerError, safeRollback };
