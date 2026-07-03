const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
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

  users: {
    list: () => request('/users'),
    create: (username) => request('/users', { method: 'POST', body: JSON.stringify({ username }) }),
    delete: (userId) => request(`/users/${userId}`, { method: 'DELETE' }),
  },

  sessions: {
    list: (userId) => request(`/sessions?userId=${userId}`),
    create: (userId, name, description, planType = 'topic', topics = [], difficulties = [], projects = [], categories = [], datasetId = null) =>
      request('/sessions', { method: 'POST', body: JSON.stringify({ userId, name, description, planType, topics, difficulties, projects, categories, ...(datasetId ? { datasetId } : {}) }) }),
    filters: (sessionId) => request(`/sessions/${sessionId}/filters`),
    update: (sessionId, updates) =>
      request(`/sessions/${sessionId}`, { method: 'PATCH', body: JSON.stringify(updates) }),
    complete: (sessionId, userId) =>
      request(`/sessions/${sessionId}/complete`, { method: 'PATCH', body: JSON.stringify({ userId }) }),
    reopen: (sessionId, userId) =>
      request(`/sessions/${sessionId}/reopen`, { method: 'PATCH', body: JSON.stringify({ userId }) }),
    open: (sessionId, userId) =>
      request(`/sessions/${sessionId}/open`, { method: 'PATCH', body: JSON.stringify({ userId }) }),
    delete: (sessionId, userId) => request(`/sessions/${sessionId}`, { method: 'DELETE', body: JSON.stringify({ userId }) }),
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

  query: (sql, taskId, userId, sessionId) =>
    request('/query', {
      method: 'POST',
      body: JSON.stringify({
        sql,
        ...(taskId    ? { taskId }    : {}),
        ...(userId    ? { userId }    : {}),
        ...(sessionId ? { sessionId } : {}),
      }),
    }),

  progress: {
    summary: (userId, sessionId) => {
      const p = new URLSearchParams();
      if (userId)    p.set('userId',    userId);
      if (sessionId) p.set('sessionId', sessionId);
      const q = p.toString();
      return request(`/progress/summary${q ? `?${q}` : ''}`);
    },
    taskStatuses: (userId, sessionId) => {
      const p = new URLSearchParams();
      if (userId)    p.set('userId',    userId);
      if (sessionId) p.set('sessionId', sessionId);
      const q = p.toString();
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
    check: (id, userSql, userId, sessionId) =>
      request(`/tasks/${id}/check`, {
        method: 'POST',
        body: JSON.stringify({
          userSql,
          ...(userId    ? { userId }    : {}),
          ...(sessionId ? { sessionId } : {}),
        }),
      }),
  },
};
