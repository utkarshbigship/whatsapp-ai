// In-memory per-cluster run lock. Single-process only (PM2 instances must be 1).
// Used to prevent duplicate master runs and to surface "report being generated" to the dashboard.
const locks = new Map(); // clusterId -> { startedAt }

module.exports = {
  begin(clusterId) { locks.set(clusterId, { startedAt: Math.floor(Date.now() / 1000) }); },
  end(clusterId)   { locks.delete(clusterId); },
  status(clusterId) {
    const l = locks.get(clusterId);
    return l ? { running: true, startedAt: l.startedAt } : { running: false, startedAt: null };
  },
};
