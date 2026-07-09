import { useConfirmDialog } from '../utils/useConfirmDialog';
import ConfirmModal from './shared/ConfirmModal';
import { useResizableSidebar } from './sidebar/useResizableSidebar';
import SidebarUserPanel from './sidebar/SidebarUserPanel';
import SidebarSessionPanel from './sidebar/SidebarSessionPanel';
import SidebarNav from './sidebar/SidebarNav';
import SidebarStatus from './sidebar/SidebarStatus';

// Composition shell only — the actual behavior lives in the sidebar/*
// components: SidebarUserPanel (account/logout/self-delete),
// SidebarSessionPanel (session switcher + create/archive/delete/complete/
// reopen + archived list), SidebarNav (navigation + DB tree), SidebarStatus
// (health dot). The confirm dialog is owned here so every panel shares a
// single ConfirmModal instance.
export default function Sidebar({
  currentView,
  onNavigate,
  selectedTable,
  onSelectTable,
  activeUser,
  onLogout,
  onDeleteUser,
  sessions,
  activeSession,
  onSessionChange,
  onCreateSession,
  onArchiveSession,
  onRestoreSession,
  onDeleteSession,
  onCompleteSession,
  onReopenSession,
  canReopenSession,
  viewedUser,
  isMentorOverview,
  requestOpenAddSession,
  onRequestOpenAddSessionConsumed,
}) {
  const { confirm, dialogProps } = useConfirmDialog();
  const { sidebarRef, sidebarWidth, startResize } = useResizableSidebar();

  return (
    <div className="sidebar-wrapper" ref={sidebarRef} style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
      <div className="sidebar">
        <div className="sidebar-logo">
          <h1>SQL Practice</h1>
          <span>PostgreSQL Trainer</span>
        </div>

        <SidebarUserPanel
          activeUser={activeUser}
          onLogout={onLogout}
          onDeleteUser={onDeleteUser}
          confirm={confirm}
        />

        <SidebarSessionPanel
          activeUser={activeUser}
          viewedUser={viewedUser}
          isMentorOverview={isMentorOverview}
          sessions={sessions}
          activeSession={activeSession}
          onSessionChange={onSessionChange}
          onNavigate={onNavigate}
          onCreateSession={onCreateSession}
          onArchiveSession={onArchiveSession}
          onRestoreSession={onRestoreSession}
          onDeleteSession={onDeleteSession}
          onCompleteSession={onCompleteSession}
          onReopenSession={onReopenSession}
          canReopenSession={canReopenSession}
          requestOpenAddSession={requestOpenAddSession}
          onRequestOpenAddSessionConsumed={onRequestOpenAddSessionConsumed}
          confirm={confirm}
        />

        <SidebarNav
          currentView={currentView}
          onNavigate={onNavigate}
          selectedTable={selectedTable}
          onSelectTable={onSelectTable}
          activeUser={activeUser}
          activeSessionId={activeSession?.id}
        />

        <SidebarStatus />
      </div>

      <div
        className="sidebar-resize-handle"
        onMouseDown={startResize}
        title="Drag to resize sidebar"
      />

      <ConfirmModal {...dialogProps} />
    </div>
  );
}
