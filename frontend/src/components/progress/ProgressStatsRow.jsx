import ProgressBar from './ProgressBar';

// Overall Solved / In Progress / Not Started stat cards.
export default function ProgressStatsRow({ solved, totalTasks, inProgress }) {
  const notStarted = totalTasks - solved - inProgress;
  const pct        = totalTasks === 0 ? 0 : Math.round((solved / totalTasks) * 100);

  return (
    <div className="progress-stats-row">
      <div className="progress-stat-card progress-stat-card--main">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
          <span className="progress-stat-value" style={{ color: 'var(--green)' }}>{solved}</span>
          <span style={{ color: 'var(--text-muted)', fontSize: 16 }}>/ {totalTasks} Solved, {pct}%</span>
        </div>
        <div className="progress-stat-label" style={{ marginBottom: 12 }}>Progress</div>
        <ProgressBar value={solved} max={totalTasks} color="var(--green)" />
      </div>

      <div className="progress-stat-card">
        <div className="progress-stat-value" style={{ color: 'var(--yellow)' }}>{inProgress}</div>
        <div className="progress-stat-label">In Progress</div>
      </div>
      <div className="progress-stat-card">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span className="progress-stat-value" style={{ color: 'var(--text-muted)' }}>{notStarted}</span>
          <span style={{ color: 'var(--text-muted)', fontSize: 16 }}>/ {totalTasks}</span>
        </div>
        <div className="progress-stat-label">Not Started</div>
      </div>
    </div>
  );
}
