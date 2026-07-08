const BASE = '/api';

async function request(path, options = {}) {
  const { headers, ...rest } = options;
  const res = await fetch(`${BASE}${path}`, {
    // Vite's dev proxy makes /api same-origin, so the session cookie is
    // already sent by default — explicit here so it doesn't depend on that.
    credentials: 'same-origin',
    ...rest,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(res.ok
      ? 'Server returned an unexpected response. Please try again.'
      : 'Request failed. Please try again.'
    );
  }

  if (!res.ok) throw new Error(data?.error || 'Request failed. Please try again.');
  return data;
}

export const api = {
  health: () => request('/health'),

  auth: {
    login: (username, password) =>
      request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
    logout: () => request('/auth/logout', { method: 'POST' }),
    me: () => request('/auth/me'),
  },

  // Acting user is resolved from the session cookie — must be an admin (enforced backend-side).
  users: {
    list: () => request('/users'),
    create: (username, role, password) =>
      request('/users', { method: 'POST', body: JSON.stringify({ username, role, password }) }),
    delete: (userId) => request(`/users/${userId}`, { method: 'DELETE' }),
    resetPassword: (userId, newPassword) =>
      request(`/users/${userId}/password`, { method: 'PATCH', body: JSON.stringify({ newPassword }) }),
    updateRole: (userId, role) =>
      request(`/users/${userId}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }),
    // Aggregated counts only (no raw user/session rows) — powers the admin
    // summary cards in UserManagementView.
    adminSummary: () => request('/users/admin-summary'),
  },

  // Admin-only (enforced backend-side).
  mentorAssignments: {
    list: () => request('/mentor-assignments'),
    create: (mentorId, studentId) =>
      request('/mentor-assignments', { method: 'POST', body: JSON.stringify({ mentorId, studentId }) }),
    delete: (assignmentId) => request(`/mentor-assignments/${assignmentId}`, { method: 'DELETE' }),
  },

  // Mentor-only (enforced backend-side) — the logged-in mentor's own assigned students.
  mentorStudents: {
    list: () => request('/mentor/students'),
    // Aggregated per-student counts (sessions by status, solved count, last
    // activity) in one call — powers the My Students overview table.
    summary: () => request('/mentor/students/summary'),
    // Mentor (if assigned) or admin — backend re-authorizes via
    // canAccessStudent regardless of what studentId is passed here.
    sessions: (studentId) => request(`/mentor/students/${studentId}/sessions`),
  },

  // userId is never sent — the backend resolves it from the session cookie
  // and only ever acts on the caller's own sessions, unless targetUserId is
  // explicitly passed (list/create), which the backend re-authorizes itself.
  sessions: {
    // targetUserId is optional — only sent when a mentor/admin is viewing
    // another user's sessions (see App.jsx's viewedUser). Omitted entirely
    // for normal self-viewing, so existing calls are unchanged.
    // includeArchived is optional — only sent by the Sidebar's "show archived
    // sessions" toggle; omitted (default) returns only non-archived sessions.
    list: (targetUserId, includeArchived) => {
      const params = new URLSearchParams();
      if (targetUserId) params.set('targetUserId', targetUserId);
      if (includeArchived) params.set('includeArchived', 'true');
      const q = params.toString();
      return request(`/sessions${q ? `?${q}` : ''}`);
    },
    // targetUserId is optional — only sent when a mentor/admin is creating a
    // session for the viewed user (see App.jsx handleCreateSession). Omitted
    // entirely for normal self-creation, so existing calls are unchanged.
    create: (name, description, planType = 'topic', topics = [], difficulties = [], projects = [], categories = [], datasetId = null, targetUserId = null) =>
      request('/sessions', { method: 'POST', body: JSON.stringify({ name, description, planType, topics, difficulties, projects, categories, ...(datasetId ? { datasetId } : {}), ...(targetUserId ? { targetUserId } : {}) }) }),
    filters: (sessionId) => request(`/sessions/${sessionId}/filters`),
    update: (sessionId, updates) =>
      request(`/sessions/${sessionId}`, { method: 'PATCH', body: JSON.stringify(updates) }),
    complete: (sessionId) => request(`/sessions/${sessionId}/complete`, { method: 'PATCH' }),
    reopen: (sessionId) => request(`/sessions/${sessionId}/reopen`, { method: 'PATCH' }),
    open: (sessionId) => request(`/sessions/${sessionId}/open`, { method: 'PATCH' }),
    // Archive is the normal user-facing way to remove a session from view —
    // it preserves all history and is restorable (see restore below).
    archive: (sessionId) => request(`/sessions/${sessionId}/archive`, { method: 'PATCH' }),
    restore: (sessionId) => request(`/sessions/${sessionId}/restore`, { method: 'PATCH' }),
    // Maintenance-only — permanently destroys the session and its history.
    // Not called from any normal UI flow; kept for direct/admin use only.
    delete: (sessionId) => request(`/sessions/${sessionId}`, { method: 'DELETE' }),
  },

  datasets: {
    list: () => request('/datasets'),
  },

  tables: {
    list: (sessionId) => {
      const q = sessionId ? `?sessionId=${sessionId}` : '';
      return request(`/tables${q}`);
    },
    columns: (name, sessionId) => {
      const q = sessionId ? `?sessionId=${sessionId}` : '';
      return request(`/tables/${name}/columns${q}`);
    },
    preview: (name, sessionId) => {
      const q = sessionId ? `?sessionId=${sessionId}` : '';
      return request(`/tables/${name}/preview${q}`);
    },
  },

  // userId is never sent — the backend resolves it from the session cookie.
  query: (sql, taskId, sessionId) =>
    request('/query', {
      method: 'POST',
      body: JSON.stringify({
        sql,
        ...(taskId    ? { taskId }    : {}),
        ...(sessionId ? { sessionId } : {}),
      }),
    }),

  // userId is never sent — the backend resolves it from the session cookie,
  // unless targetUserId is explicitly passed (a mentor/admin viewing
  // another user), which the backend re-authorizes itself.
  progress: {
    summary: (sessionId, targetUserId) => {
      const params = new URLSearchParams();
      if (sessionId) params.set('sessionId', sessionId);
      if (targetUserId) params.set('targetUserId', targetUserId);
      const q = params.toString();
      return request(`/progress/summary${q ? `?${q}` : ''}`);
    },
    taskStatuses: (sessionId, targetUserId) => {
      const params = new URLSearchParams();
      if (sessionId) params.set('sessionId', sessionId);
      if (targetUserId) params.set('targetUserId', targetUserId);
      const q = params.toString();
      return request(`/progress/tasks-status${q ? `?${q}` : ''}`);
    },
  },

  tasks: {
    categories: () => request('/tasks/categories'),
    list: (filters = {}) => {
      const params = new URLSearchParams(
        Object.fromEntries(Object.entries(filters).filter(([, v]) => v != null))
      ).toString();
      return request(`/tasks${params ? `?${params}` : ''}`);
    },
    get: (id) => request(`/tasks/${id}`),
    solution: (id) => request(`/tasks/${id}/solution`),
    // userId is never sent — the backend resolves it from the session cookie.
    check: (id, userSql, sessionId) =>
      request(`/tasks/${id}/check`, {
        method: 'POST',
        body: JSON.stringify({
          userSql,
          ...(sessionId ? { sessionId } : {}),
        }),
      }),
  },
};
