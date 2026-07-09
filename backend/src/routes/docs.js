const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const swaggerUi = require('swagger-ui-express');

const router = express.Router();

// Disabled by default in production (an API-docs page spells out the app's
// role/authz shape — fine for local development, not something to expose by
// default once real user accounts exist). ENABLE_API_DOCS lets this be
// force-enabled (e.g. "true") or force-disabled ("false") regardless of
// NODE_ENV, for the rare case someone wants to demo it in a prod-like
// environment or turn it off locally.
function isDocsEnabled() {
  const override = process.env.ENABLE_API_DOCS;
  if (override === 'true') return true;
  if (override === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

if (isDocsEnabled()) {
  const specPath = path.join(__dirname, '..', '..', 'openapi', 'openapi.yaml');
  const spec = yaml.load(fs.readFileSync(specPath, 'utf8'));
  router.use('/', swaggerUi.serve, swaggerUi.setup(spec));
} else {
  router.use('/', (req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });
}

module.exports = router;
