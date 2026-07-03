'use strict';

/**
 * Manual, one-off script to set (or reset) a user's password.
 *
 * Real login does not exist yet — this only prepares data for it. Existing
 * accounts have no password_hash until this script is run for them.
 *
 * Usage:
 *   node scripts/set-user-password.js <username> <newPassword>
 *
 * Never prints the raw password or the resulting hash — only a generic
 * success message.
 */

const bcrypt = require('bcryptjs');
const pool = require('../src/db');

const MIN_PASSWORD_LENGTH = 8;
const BCRYPT_COST = 10;

async function run() {
  const [, , username, password] = process.argv;

  if (!username || !username.trim()) {
    console.error('Error: username is required.');
    console.error('Usage: node scripts/set-user-password.js <username> <newPassword>');
    process.exitCode = 1;
    return;
  }

  if (!password) {
    console.error('Error: newPassword is required.');
    console.error('Usage: node scripts/set-user-password.js <username> <newPassword>');
    process.exitCode = 1;
    return;
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Error: password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exitCode = 1;
    return;
  }

  try {
    const userCheck = await pool.query('SELECT id FROM users WHERE username = $1', [username.trim()]);
    if (userCheck.rows.length === 0) {
      console.error(`Error: no user found with username "${username.trim()}".`);
      process.exitCode = 1;
      return;
    }

    const hash = await bcrypt.hash(password, BCRYPT_COST);
    await pool.query('UPDATE users SET password_hash = $1 WHERE username = $2', [hash, username.trim()]);

    console.log(`Password set successfully for user "${username.trim()}".`);
  } catch (err) {
    console.error('Error: failed to set password:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run();
