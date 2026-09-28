// Recover missed stream events without calling any external service.
(() => {
  let busy = false;
  async function sync() {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch('/api/state', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const snapshot = await response.json();
      window.dispatchEvent(new CustomEvent('sync-live-state', { detail: snapshot }));
    } catch { /* EventSource and the next local poll both retry independently. */ }
    finally { busy = false; }
  }
  setInterval(sync, 2000);
  window.addEventListener('online', sync);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void sync(); });
  void sync();
})();
