// In-memory run lock. Single-process only (PM2 instances must be 1).
// Two layers:
//   - a GLOBAL lock that batch-level runs (group batches + masters) hold so they
//     never overlap and double-generate;
//   - per-cluster keys, used only to surface "report being generated" per cluster
//     to the dashboard.
const GLOBAL = '__global__';
const locks = new Map(); // key -> { startedAt }

const now = () => Math.floor(Date.now() / 1000);

module.exports = {
  begin(key) { locks.set(key, { startedAt: now() }); },
  end(key)   { locks.delete(key); },
  status(key) {
    const l = locks.get(key);
    return l ? { running: true, startedAt: l.startedAt } : { running: false, startedAt: null };
  },
  beginGlobal() { locks.set(GLOBAL, { startedAt: now() }); },
  endGlobal()   { locks.delete(GLOBAL); },
  globalStatus() { return this.status(GLOBAL); },
  // True if a global batch OR any per-cluster run is in progress.
  anyBatchRunning() {
    if (!locks.size) return { running: false, startedAt: null };
    const startedAt = Math.min(...[...locks.values()].map((l) => l.startedAt));
    return { running: true, startedAt };
  },
};
