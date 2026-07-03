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
const tablesRouter = require('./routes/tables');
const queryRouter = require('./routes/query');
const tasksRouter = require('./routes/tasks');
const progressRouter = require('./routes/progress');
const usersRouter = require('./routes/users');
const sessionsRouter = require('./routes/sessions');
const datasetsRouter = require('./routes/datasets');
const authRouter = require('./routes/auth');
const pool = require('./db');
const initDb = require('./initDb');

const app = express();
const PORT = process.env.PORT || 3001;
const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days, rolling

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

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', database: err.message });
  }
});

// Global JSON error handler — must be registered after all routes
// Without this, Express sends HTML error pages which the frontend can't parse
app.use((err, req, res, next) => {
  console.error('[Unhandled error]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error.' });
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
