import { useState } from 'react';

// Table-preview tab state (open tabs, active tab, per-table cache, panel
// visibility) plus the open/close bookkeeping around it — shared by
// TaskView and QueryPlayground, which both render the same
// TablePreviewPanel and previously carried byte-identical copies of
// closeTab and near-identical state declarations.
//
// Each caller still owns its own effect(s) for WHEN to reset/open tabs —
// TaskView resets on task switch (as part of a larger reset effect) and
// auto-opens a task's own tables once it loads; QueryPlayground resets on
// session switch and has no auto-open. Those triggers/decisions are
// intentionally NOT folded into this hook, only the state shape and the two
// operations (open one tab, close one tab) whose bodies were actually
// duplicated.
export function useTablePreviewTabs(initialVisible = false) {
  const [openTabs, setOpenTabs] = useState([]);
  const [activeTab, setActiveTab] = useState(null);
  const [tableCache, setTableCache] = useState({});
  const [previewVisible, setPreviewVisible] = useState(initialVisible);

  // Clears tabs/cache without touching previewVisible — callers that need
  // the panel hidden too (e.g. on a task switch) still set that explicitly.
  function resetTabs() {
    setOpenTabs([]);
    setActiveTab(null);
    setTableCache({});
  }

  // Opens (or focuses, if already open) a single table tab and reveals the
  // panel — the shared body of the "open a table tab requested from
  // elsewhere" effects in both TaskView and QueryPlayground.
  function openTab(tableName) {
    setOpenTabs(prev => prev.includes(tableName) ? prev : [...prev, tableName]);
    setActiveTab(tableName);
    setPreviewVisible(true);
  }

  function closeTab(tableName, e) {
    e.stopPropagation();
    const newTabs = openTabs.filter(t => t !== tableName);
    setOpenTabs(newTabs);
    if (activeTab === tableName) {
      const idx = openTabs.indexOf(tableName);
      setActiveTab(newTabs[Math.min(idx, newTabs.length - 1)] ?? null);
    }
  }

  return {
    openTabs, activeTab, tableCache, previewVisible,
    setOpenTabs, setActiveTab, setTableCache, setPreviewVisible,
    resetTabs, openTab, closeTab,
  };
}
