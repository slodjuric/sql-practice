import { api } from '../api';

// Compact per-student stats shared by MyStudentsView (mentor's own roster)
// and MentorOverviewView (admin reviewing a mentor's roster) — both need the
// same solved/total, session count, and last-activity numbers for a student
// id, without a new backend endpoint. GET /api/progress/summary and
// GET /api/sessions are already authorized for the caller on any id they can
// access (self, assigned student, or any user for admin).
export async function fetchStudentStats(studentId) {
  const [progress, sessions] = await Promise.all([
    api.progress.summary(undefined, studentId).catch(() => null),
    api.sessions.list(studentId).catch(() => []),
  ]);
  return {
    solved: progress?.solved ?? null,
    totalTasks: progress?.totalTasks ?? null,
    lastActivity: progress?.recentAttempts?.[0]?.createdAt ?? null,
    sessionCount: Array.isArray(sessions) ? sessions.length : 0,
  };
}

export function formatDateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const day   = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${d.getFullYear()}`;
}
