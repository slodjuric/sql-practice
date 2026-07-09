import { useEffect, useRef, useState } from 'react';

const SIDEBAR_WIDTH_KEY = 'sidebarWidth';
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 520;
const DEFAULT_SIDEBAR_WIDTH = 240;

function clampSidebarWidth(width) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function readStoredSidebarWidth() {
  try {
    const raw = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
    if (!isNaN(raw)) return clampSidebarWidth(raw);
  } catch {}
  return DEFAULT_SIDEBAR_WIDTH;
}

// Drag-to-resize behavior for the sidebar: width is clamped, persisted to
// localStorage on mouse-up, and restored on the next load. Attach
// `sidebarRef` to the resized container and `startResize` to the handle's
// onMouseDown.
export function useResizableSidebar() {
  const sidebarRef = useRef(null);
  const resizingRef = useRef(false);
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth);

  useEffect(() => {
    function onMouseMove(e) {
      if (!resizingRef.current || !sidebarRef.current) return;
      const left = sidebarRef.current.getBoundingClientRect().left;
      setSidebarWidth(clampSidebarWidth(e.clientX - left));
    }
    function onMouseUp() {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setSidebarWidth(width => {
        try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)); } catch {}
        return width;
      });
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  function startResize(e) {
    e.preventDefault();
    resizingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  return { sidebarRef, sidebarWidth, startResize };
}
