'use strict';

const bcrypt = require('bcryptjs');

// Single source of truth for password rules — previously duplicated
// separately in routes/users.js and scripts/set-user-password.js.
const MIN_PASSWORD_LENGTH = 8;
const BCRYPT_COST = 10;

function validatePasswordLength(password) {
  return typeof password === 'string' && password.length >= MIN_PASSWORD_LENGTH;
}

function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

module.exports = { MIN_PASSWORD_LENGTH, BCRYPT_COST, validatePasswordLength, hashPassword };
