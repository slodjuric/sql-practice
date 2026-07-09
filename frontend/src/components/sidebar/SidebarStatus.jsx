import { useEffect, useState } from 'react';
import { api } from '../../api';

// Backend/database connectivity indicator in the sidebar footer — checks
// once on mount via /api/health.
export default function SidebarStatus() {
  const [dbStatus, setDbStatus] = useState('checking');

  useEffect(() => {
    api.health()
      .then(() => setDbStatus('connected'))
      .catch(() => setDbStatus('error'));
  }, []);

  return (
    <div className="sidebar-status">
      <div className={`status-dot ${dbStatus}`}>
        {dbStatus === 'connected' ? 'sql_practice' : dbStatus === 'error' ? 'DB not connected' : 'Connecting...'}
      </div>
    </div>
  );
}
