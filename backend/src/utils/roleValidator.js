'use strict';

const VALID_ROLES = ['admin', 'mentor', 'student'];

function isValidRole(role) {
  return VALID_ROLES.includes(role);
}

module.exports = { VALID_ROLES, isValidRole };
