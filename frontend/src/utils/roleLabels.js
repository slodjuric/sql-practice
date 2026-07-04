// DB-level role values stay admin/mentor/student — "mentor" is displayed as
// "Professor" everywhere user-facing.
const ROLE_LABELS = { admin: 'Admin', mentor: 'Professor', student: 'Student' };

export function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}
