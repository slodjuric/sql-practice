export default function StatusBadge({ status }) {
  if (status === 'solved')
    return <span className="status-badge status-badge--solved">✓ solved</span>;
  if (status === 'in_progress')
    return <span className="status-badge status-badge--in-progress">in progress</span>;
  return <span className="status-badge status-badge--not-started">not started</span>;
}
