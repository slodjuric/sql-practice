// Shared between the container's validation handlers and the extracted forms.
// MIN_PASSWORD_LENGTH mirrors the backend's passwordPolicy.js — the backend
// remains the authority; this only provides the friendlier pre-flight message.
export const ROLE_OPTIONS = ['student', 'mentor', 'admin'];
export const MIN_PASSWORD_LENGTH = 8;
