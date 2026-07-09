// Compact DD.MM.YYYY date formatting — shared by ProgressView (session
// created/completed/last-activity dates) and the mentor roster views
// (MyStudentsView/MentorOverviewView, via utils/studentRoster.js). Both used
// to carry their own byte-identical copy of this function.
export function formatDateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const day   = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${d.getFullYear()}`;
}
