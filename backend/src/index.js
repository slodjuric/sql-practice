const express = require('express');
const cors = require('cors');
require('dotenv').config();

const tablesRouter = require('./routes/tables');
const queryRouter = require('./routes/query');
const tasksRouter = require('./routes/tasks');
const progressRouter = require('./routes/progress');
const usersRouter = require('./routes/users');
const sessionsRouter = require('./routes/sessions');
const datasetsRouter = require('./routes/datasets');
const pool = require('./db');
const initDb = require('./initDb');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

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
