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

  users: {
    list: () => request('/users'),
    create: (username) => request('/users', { method: 'POST', body: JSON.stringify({ username }) }),
    // Acting user is resolved from the session cookie — must be an admin (enforced backend-side).
    delete: (userId) => request(`/users/${userId}`, { method: 'DELETE' }),
  },

  // userId is never sent — the backend resolves it from the session cookie
  // and only ever acts on the caller's own sessions.
  sessions: {
    list: () => request('/sessions'),
    create: (name, description, planType = 'topic', topics = [], difficulties = [], projects = [], categories = [], datasetId = null) =>
      request('/sessions', { method: 'POST', body: JSON.stringify({ name, description, planType, topics, difficulties, projects, categories, ...(datasetId ? { datasetId } : {}) }) }),
    filters: (sessionId) => request(`/sessions/${sessionId}/filters`),
    update: (sessionId, updates) =>
      request(`/sessions/${sessionId}`, { method: 'PATCH', body: JSON.stringify(updates) }),
    complete: (sessionId) => request(`/sessions/${sessionId}/complete`, { method: 'PATCH' }),
    reopen: (sessionId) => request(`/sessions/${sessionId}/reopen`, { method: 'PATCH' }),
    open: (sessionId) => request(`/sessions/${sessionId}/open`, { method: 'PATCH' }),
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

  // userId is never sent — the backend resolves it from the session cookie.
  progress: {
    summary: (sessionId) => {
      const q = sessionId ? `?sessionId=${sessionId}` : '';
      return request(`/progress/summary${q}`);
    },
    taskStatuses: (sessionId) => {
      const q = sessionId ? `?sessionId=${sessionId}` : '';
      return request(`/progress/tasks-status${q}`);
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
