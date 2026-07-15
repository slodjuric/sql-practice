const express = require('express');
const cors = require('cors');
const session = require('express-session');
require('dotenv').config();

// Fail clearly at startup rather than silently falling back to an insecure
// default — matches how DB config is already required, not defaulted.
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error('Missing required environment variable: SESSION_SECRET. Set it in backend/.env (see .env.example).');
  process.exit(1);
}

const pgSession = require('connect-pg-simple')(session);
const { requestContext, sendUnexpectedError } = require('./utils/requestLogger');
const tablesRouter = require('./routes/tables');
const queryRouter = require('./routes/query');
const tasksRouter = require('./routes/tasks');
const progressRouter = require('./routes/progress');
const usersRouter = require('./routes/users');
const sessionsRouter = require('./routes/sessions');
const datasetsRouter = require('./routes/datasets');
const authRouter = require('./routes/auth');
const mentorAssignmentsRouter = require('./routes/mentorAssignments');
const mentorStudentsRouter = require('./routes/mentorStudents');
const docsRouter = require('./routes/docs');
const pool = require('./db');
const initDb = require('./initDb');

const app = express();
const PORT = process.env.PORT || 3001;
const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days, rolling

// Registered first so every request — including one that fails before
// reaching a route (e.g. a malformed JSON body) — gets a request id and an
// X-Request-ID response header.
app.use(requestContext);

app.use(cors());
app.use(express.json());

app.use(session({
  store: new pgSession({ pool, createTableIfMissing: true }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MAX_AGE_MS,
  },
}));

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/datasets', datasetsRouter);
app.use('/api/tables', tablesRouter);
app.use('/api/query', queryRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/progress', progressRouter);
app.use('/api/mentor-assignments', mentorAssignmentsRouter);
app.use('/api/mentor', mentorStudentsRouter);
app.use('/api-docs', docsRouter);

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', database: err.message });
  }
});

// Global JSON error handler — must be registered after all routes.
// Without this, Express sends HTML error pages which the frontend can't
// parse. In normal operation this is a pure safety net: every route below
// handles its own errors (see utils/requestLogger.js's sendUnexpectedError)
// and never calls next(err), so this only fires for something Express
// itself raises before reaching a route — e.g. a malformed JSON body from
// express.json(), which carries its own 4xx status. That's a client error,
// not an unexpected server failure, so it keeps its original status; only a
// missing/5xx status is treated as unexpected and gets the generic 500.
app.use((err, req, res, next) => {
  const knownClientStatus = (err.status || err.statusCode);
  if (knownClientStatus >= 400 && knownClientStatus < 500) {
    console.warn('Client request error', {
      requestId: req.requestId,
      userId: req.session?.userId ?? null,
      status: knownClientStatus,
      message: err.message,
    });
    return res.status(knownClientStatus).json({ error: 'Invalid request.' });
  }
  sendUnexpectedError(req, res, err, { route: 'global-error-handler' });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Backend running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
