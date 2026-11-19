const KEY = 'llmgw.sidebar-collapsed';
export function readSidebarCollapsed() {
  try { return localStorage.getItem(KEY) !== 'false'; } catch { return true; }
}
export function saveSidebarCollapsed(collapsed: boolean) {
  try { localStorage.setItem(KEY, String(collapsed)); } catch { /* keep the current in-memory preference */ }
}
