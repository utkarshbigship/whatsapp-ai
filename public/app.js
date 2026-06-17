const $ = (s) => document.querySelector(s);
let groups = [], activeGroup = null, activeName = null;
let view = 'groups', clusters = [];
const reportCache = {}; // id -> { report, name }

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, ...opts });
  if (res.status === 401) { showLogin(); throw new Error('Please sign in'); }
  // 202 = accepted-but-in-progress; let the caller handle it.
  if (res.status === 202) { const b = await res.json().catch(() => ({})); return { _status: 202, ...b }; }
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || `HTTP ${res.status}`); }
  return res.json();
}

function toast(msg, err = false) {
  const el = $('#toast'); el.textContent = msg;
  el.className = 'toast show' + (err ? ' err' : '');
  setTimeout(() => { el.className = 'toast' + (err ? ' err' : ''); }, 3500);
}
function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmt(t){ return esc(t).replace(/\*(.+?)\*/g, '<b>$1</b>'); }
function stripTokens(t){ return (t||'').replace(/\{\{G:[^}]+\}\}/g, ''); }
function timeAgo(u){ const s=Math.floor(Date.now()/1000)-u; if(s<60)return'just now';
  if(s<3600)return Math.floor(s/60)+'m ago'; if(s<86400)return Math.floor(s/3600)+'h ago'; return Math.floor(s/86400)+'d ago'; }
function clock(u){ return new Date(u*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }
function dt(u){ return new Date(u*1000).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}); }
function todayStr(){ return new Date().toISOString().slice(0,10); }
// IST midnight epoch for a YYYY-MM-DD (IST is fixed UTC+5:30).
function istMidnight(dateStr){ return Math.floor(new Date(`${dateStr}T00:00:00+05:30`).getTime()/1000); }

// Render report body: linkify {{G:id}}Name tokens into clickable chips, then *bold*.
function renderReportBody(text){
  const re = /\{\{G:([^}]+)\}\}([^\n<]*)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(text)) !== null) {
    out += fmt(text.slice(last, m.index));
    const id = m[1], name = (m[2] || '').trim();
    out += `<a href="#" class="group-chip" data-gid="${esc(id)}" data-gname="${esc(name)}">${esc(name || id)}</a>`;
    last = re.lastIndex;
  }
  out += fmt(text.slice(last));
  return out;
}

// ---- downloads (client-side, no dependency) ----
function downloadBlob(filename, content, type){
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
}
function safeName(s){ return (s||'report').replace(/[^a-z0-9_-]+/gi,'_').slice(0,60); }
function downloadMd(text, name){ downloadBlob(safeName(name)+'.md', stripTokens(text), 'text/markdown'); }
function downloadDoc(text, name){
  const body = fmt(stripTokens(text)).replace(/\n/g, '<br>');
  const html = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'></head><body>${body}</body></html>`;
  downloadBlob(safeName(name)+'.doc', html, 'application/msword');
}

// ---- shared report card rendering ----
function reportCardHtml(r){
  reportCache[r.id] = { report: r.report, name: `${r.group_name || 'report'}_${r.window_label || r.id}` };
  return `
    <div class="report-card">
      <div class="when"><span>${dt(r.created_at)}</span><span class="trigger">${esc(r.trigger||'')}</span>
        <span>${esc(r.window_label||'')}</span><span>${r.message_count} ${r.cluster_id?'groups':'msgs'}</span><span>${esc(r.model||'')}</span>
        <span class="dl"><a href="#" class="dl-btn" data-md="${r.id}">.md</a><a href="#" class="dl-btn" data-doc="${r.id}">.doc</a></span></div>
      <div class="report-body">${renderReportBody(r.report)}</div>
    </div>`;
}
function wireReportCards(container){
  container.querySelectorAll('.group-chip').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault(); setView('groups'); selectGroup(a.dataset.gid, a.dataset.gname);
    }));
  container.querySelectorAll('.dl-btn').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const c = reportCache[a.dataset.md || a.dataset.doc]; if (!c) return;
      if (a.dataset.md) downloadMd(c.report, c.name); else downloadDoc(c.report, c.name);
    }));
}

// ---- auth ----
function showLogin(){ $('#login').style.display='flex'; $('#app').style.display='none'; }
function showApp(){ $('#login').style.display='none'; $('#app').style.display='block'; loadGroups(); loadClusters(); }

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/login', { method:'POST', body: JSON.stringify({
      username: $('#username').value, password: $('#password').value }) });
    $('#loginErr').textContent = ''; showApp();
  } catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method:'POST' }).catch(()=>{}); showLogin();
});

// ---- view switching ----
function setView(v){
  view = v;
  $('#viewGroups').classList.toggle('active', v==='groups');
  $('#viewMaster').classList.toggle('active', v==='master');
  $('#viewSettings').classList.toggle('active', v==='settings');
  $('#groupsView').style.display = v==='groups' ? '' : 'none';
  $('#masterView').style.display = v==='master' ? 'block' : 'none';
  $('#settingsView').style.display = v==='settings' ? 'block' : 'none';
  if (v==='master') initMasterView();
  if (v==='settings') initSettingsView();
}
$('#viewGroups').addEventListener('click', () => setView('groups'));
$('#viewMaster').addEventListener('click', () => setView('master'));
$('#viewSettings').addEventListener('click', () => setView('settings'));

// ---- groups ----
async function loadGroups() {
  try {
    const d = await api('/api/groups'); groups = d.groups || [];
    $('#groupCount').textContent = groups.length; $('#statusText').textContent = 'live';
    renderGroups();
  } catch (e) { $('#statusText').textContent = 'error'; }
}
async function loadClusters(){
  try { const d = await api('/api/clusters'); clusters = d.clusters || []; }
  catch (e) { clusters = [{ id:'all', name:'All' }]; }
}

function renderGroups() {
  const q = $('#search').value.trim().toLowerCase();
  const list = $('#groupList');
  const f = groups.filter((g) => (g.group_name||'').toLowerCase().includes(q));
  if (!f.length) { list.innerHTML = '<div class="loading">No groups yet.</div>'; return; }
  list.innerHTML = f.map((g) => `
    <div class="group ${activeGroup===g.group_id?'active':''}" data-id="${esc(g.group_id)}" data-name="${esc(g.group_name||'')}">
      <div class="group-name">${esc(g.group_name||g.group_id)}
        <button class="del-btn" data-del="${esc(g.group_id)}" title="Delete group data">×</button>
      </div>
      <div class="group-meta">
        <span class="chip-live">${g.today_messages} today</span>
        <span class="chip">${g.total_messages} total</span>
        <span>${timeAgo(g.last_message_ts)}</span>
      </div>
    </div>`).join('');

  list.querySelectorAll('.group').forEach((el) =>
    el.addEventListener('click', (ev) => {
      if (ev.target.dataset.del) return;
      selectGroup(el.dataset.id, el.dataset.name);
    }));
  list.querySelectorAll('.del-btn').forEach((b) =>
    b.addEventListener('click', (ev) => { ev.stopPropagation(); deleteGroup(b.dataset.del); }));
}

async function deleteGroup(id) {
  if (!confirm('Delete all stored messages and reports for this group? This cannot be undone.')) return;
  try {
    const r = await api('/api/groups/'+encodeURIComponent(id), { method:'DELETE' });
    toast(`Deleted ${r.messages} messages, ${r.reports} reports.`);
    if (activeGroup === id) { activeGroup = null; $('#detail').innerHTML = emptyDetail(); }
    loadGroups();
  } catch (e) { toast(e.message, true); }
}

function emptyDetail() {
  return `<div class="detail-empty"><div class="big">Select a group</div>
    <div>Pick a group to analyse escalations and view past reports.</div></div>`;
}

function selectGroup(id, name) {
  activeGroup = id; activeName = name; renderGroups();
  const today = todayStr();
  const clusterOpts = clusters.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  $('#detail').innerHTML = `
    <div class="detail-head">
      <div><h2>${esc(name)}</h2><div class="sub">${esc(id)}</div></div>
      <label class="cluster-pick">Cluster <select id="grpCluster" class="date-field">${clusterOpts}</select></label>
    </div>
    <div class="section">
      <h3>Analyse</h3>
      <div class="controls">
        <label>From <input type="date" id="fromDate" class="date-field" value="${today}"></label>
        <label>To <input type="date" id="toDate" class="date-field" value="${today}"></label>
        <label><input type="checkbox" id="last24" checked> last 24h (ignore dates)</label>
        <label><input type="checkbox" id="deliver"> send to WhatsApp</label>
        <button class="btn" id="runBtn">Analyse escalations</button>
      </div>
      <div id="contextPicker" class="context-picker"></div>
    </div>
    <div class="section"><h3>Reports</h3><div id="reports"><div class="loading">Loading…</div></div></div>
    <div class="section"><h3>Recent messages</h3><div id="messages"><div class="loading">Loading…</div></div></div>`;
  $('#runBtn').addEventListener('click', () => runAnalyse(id, name));
  $('#fromDate').addEventListener('change', () => loadReports(id));
  $('#grpCluster').addEventListener('change', async (e) => {
    try { await api(`/api/groups/${encodeURIComponent(id)}/cluster`, { method:'POST',
      body: JSON.stringify({ clusterId: e.target.value, groupName: name }) });
      toast('Cluster updated.'); } catch (err) { toast(err.message, true); }
  });
  loadReports(id); loadMessages(id);
}

async function loadReports(id) {
  try {
    const { reports } = await api(`/api/groups/${encodeURIComponent(id)}/reports?limit=20`);
    const box = $('#reports');
    const picker = $('#contextPicker');

    if (picker) {
      // Suggest the report(s) immediately before the chosen window as context.
      let suggested = new Set();
      const fromEl = $('#fromDate');
      if (fromEl && fromEl.value && !$('#last24').checked) {
        try {
          const beforeTs = istMidnight(fromEl.value);
          const s = await api(`/api/groups/${encodeURIComponent(id)}/context-suggestions?beforeTs=${beforeTs}&limit=2`);
          (s.suggestions || []).forEach((x) => suggested.add(x.id));
        } catch (_) {}
      }
      picker.innerHTML = !reports.length ? '' :
        '<div class="context-label">Send previous reports as context (suggested pre-checked):</div>' +
        reports.map((r) => `
          <label class="context-item">
            <input type="checkbox" class="ctx" value="${r.id}" ${suggested.has(r.id)?'checked':''}>
            <span>${dt(r.created_at)} · ${esc(r.window_label || '')}</span>
          </label>`).join('');
    }

    if (!reports.length) { box.innerHTML = '<div class="loading">No reports yet. Run an analysis above.</div>'; return; }
    box.innerHTML = reports.map(reportCardHtml).join('');
    wireReportCards(box);
  } catch (e) { $('#reports').innerHTML = `<div class="loading">${e.message}</div>`; }
}

async function loadMessages(id) {
  try {
    const { messages } = await api(`/api/groups/${encodeURIComponent(id)}/messages?limit=80`);
    const box = $('#messages');
    if (!messages.length) { box.innerHTML = '<div class="loading">No messages stored.</div>'; return; }
    box.innerHTML = messages.slice().reverse().map((m) => `
      <div class="msg"><span class="t">${clock(m.timestamp)}</span>
        <span class="a">${esc(m.author_name||m.author||'?')}</span>
        <span class="b ${m.msg_type&&m.msg_type!=='chat'?'media':''}">${esc(m.body|| '['+(m.msg_type||'media')+']')}</span></div>`).join('');
  } catch (e) { $('#messages').innerHTML = `<div class="loading">${e.message}</div>`; }
}

async function runAnalyse(id, name) {
  const btn = $('#runBtn');
  const last24 = $('#last24').checked;
  const body = { groupName: name, deliver: $('#deliver').checked };
  if (!last24) { body.fromDate = $('#fromDate').value; body.toDate = $('#toDate').value; }
  const ctxIds = Array.from(document.querySelectorAll('.ctx:checked')).map((c) => parseInt(c.value, 10));
  if (ctxIds.length) body.contextReportIds = ctxIds;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Analysing…';
  try {
    const res = await api(`/api/groups/${encodeURIComponent(id)}/analyse`, { method:'POST', body: JSON.stringify(body) });
    const ctxNote = ctxIds.length ? ` (with ${ctxIds.length} prior report${ctxIds.length>1?'s':''} as context)` : '';
    toast((res.delivered ? 'Report generated and sent to WhatsApp' : 'Report generated') + ctxNote + '.');
    loadReports(id);
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.textContent = 'Analyse escalations'; }
}

// ---- master view ----
let masterInited = false;
function initMasterView(){
  if (!masterInited) {
    $('#mFromDate').value = todayStr(); $('#mToDate').value = todayStr();
    $('#mRunBtn').addEventListener('click', runMasterAnalyse);
    $('#mFromDate').addEventListener('change', loadMasterReports);
    masterInited = true;
  }
  $('#mCluster').innerHTML = clusters.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  loadMasterReports();
}
function selectedCluster(){ return $('#mCluster').value || 'all'; }

async function loadMasterReports(){
  try {
    const clusterId = selectedCluster();
    const { reports, lock } = await api(`/api/master/reports?clusterId=${encodeURIComponent(clusterId)}&limit=20`);
    const box = $('#masterReports');

    // context suggestions for the chosen window
    const picker = $('#mContextPicker');
    let suggested = new Set();
    if (!$('#mLast24').checked && $('#mFromDate').value) {
      try {
        const beforeTs = istMidnight($('#mFromDate').value);
        const s = await api(`/api/master/context-suggestions?clusterId=${encodeURIComponent(clusterId)}&beforeTs=${beforeTs}&limit=2`);
        (s.suggestions || []).forEach((x) => suggested.add(x.id));
      } catch (_) {}
    }
    picker.innerHTML = !reports.length ? '' :
      '<div class="context-label">Send previous master reports as context (suggested pre-checked):</div>' +
      reports.map((r) => `
        <label class="context-item">
          <input type="checkbox" class="mctx" value="${r.id}" ${suggested.has(r.id)?'checked':''}>
          <span>${dt(r.created_at)} · ${esc(r.window_label || '')}</span>
        </label>`).join('');

    const banner = (lock && lock.running)
      ? `<div class="loading">⏳ A report is being generated (started ${timeAgo(lock.startedAt)}). It will appear here when ready.</div>` : '';
    if (!reports.length) { box.innerHTML = banner + '<div class="loading">No master reports yet.</div>'; return; }
    box.innerHTML = banner + reports.map(reportCardHtml).join('');
    wireReportCards(box);
  } catch (e) { $('#masterReports').innerHTML = `<div class="loading">${e.message}</div>`; }
}

async function runMasterAnalyse(){
  const btn = $('#mRunBtn');
  const clusterId = selectedCluster();
  const body = { clusterId, deliver: $('#mDeliver').checked };
  if (!$('#mLast24').checked) { body.fromDate = $('#mFromDate').value; body.toDate = $('#mToDate').value; }
  const ctxIds = Array.from(document.querySelectorAll('.mctx:checked')).map((c) => parseInt(c.value, 10));
  if (ctxIds.length) body.contextReportIds = ctxIds;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Analysing…';
  try {
    const res = await api('/api/master/analyse', { method:'POST', body: JSON.stringify(body) });
    if (res._status === 202) {
      const mins = Math.max(0, Math.floor((Date.now()/1000 - res.startedAt)/60));
      toast(`A report is already being generated (started ${mins} min ago). It will appear when ready.`);
      pollMaster(clusterId);
    } else {
      toast(res.delivered ? 'Master report generated and sent to WhatsApp.' : 'Master report generated.');
      loadMasterReports();
    }
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.textContent = 'Analyse all groups'; }
}

// Poll until the in-progress run saves its master report, then refresh.
function pollMaster(clusterId){
  let tries = 0;
  const iv = setInterval(async () => {
    tries++;
    try {
      const { lock } = await api(`/api/master/reports?clusterId=${encodeURIComponent(clusterId)}&limit=1`);
      if (!lock || !lock.running) { clearInterval(iv); loadMasterReports(); toast('Master report ready.'); }
    } catch (_) {}
    if (tries > 120) clearInterval(iv); // give up after ~10 min
  }, 5000);
}

// ---- settings view ----
function initSettingsView(){
  loadClusterManager();
  loadAssignList();
  loadSchedules();
  $('#clAddBtn').onclick = async () => {
    const id = $('#clId').value.trim(), name = $('#clName').value.trim();
    if (!id || !name) return toast('id and name required', true);
    try { await api('/api/clusters', { method:'POST', body: JSON.stringify({ id, name }) });
      $('#clId').value=''; $('#clName').value=''; await loadClusters(); loadClusterManager(); loadAssignList(); toast('Cluster saved.'); }
    catch (e) { toast(e.message, true); }
  };
  $('#schAddBtn').onclick = async () => {
    const time_hhmm = $('#schTime').value, label = $('#schLabel').value.trim(), window_mode = $('#schWindow').value;
    if (!time_hhmm) return toast('time required', true);
    try { await api('/api/schedules', { method:'POST', body: JSON.stringify({ time_hhmm, label, window_mode, enabled: 1 }) });
      $('#schLabel').value=''; loadSchedules(); toast('Schedule added.'); }
    catch (e) { toast(e.message, true); }
  };
}
function loadClusterManager(){
  $('#clusterList').innerHTML = clusters.map((c) =>
    `<div class="row"><span class="chip">${esc(c.id)}</span> ${esc(c.name)}</div>`).join('') || '<div class="loading">No clusters.</div>';
}
async function loadAssignList(){
  const box = $('#assignList');
  if (!groups.length) { box.innerHTML = '<div class="loading">No groups.</div>'; return; }
  const opts = (sel) => clusters.map((c) => `<option value="${esc(c.id)}" ${sel===c.id?'selected':''}>${esc(c.name)}</option>`).join('');
  // fetch current assignment per cluster once
  const assigned = {};
  for (const c of clusters) {
    try { const { groups: gs } = await api(`/api/clusters/${encodeURIComponent(c.id)}/groups`);
      gs.forEach((g) => { assigned[g.group_id] = c.id; }); } catch (_) {}
  }
  box.innerHTML = groups.map((g) => `
    <div class="row">
      <span class="assign-name">${esc(g.group_name || g.group_id)}</span>
      <select class="date-field assign-sel" data-gid="${esc(g.group_id)}" data-gname="${esc(g.group_name||'')}">${opts(assigned[g.group_id] || 'all')}</select>
    </div>`).join('');
  box.querySelectorAll('.assign-sel').forEach((sel) =>
    sel.addEventListener('change', async (e) => {
      try { await api(`/api/groups/${encodeURIComponent(e.target.dataset.gid)}/cluster`, { method:'POST',
        body: JSON.stringify({ clusterId: e.target.value, groupName: e.target.dataset.gname }) });
        toast('Assigned.'); } catch (err) { toast(err.message, true); }
    }));
}
async function loadSchedules(){
  try {
    const { schedules } = await api('/api/schedules');
    const box = $('#scheduleList');
    if (!schedules.length) { box.innerHTML = '<div class="loading">No schedules. Add one above.</div>'; return; }
    box.innerHTML = schedules.map((s) => `
      <div class="row">
        <span class="chip">${esc(s.time_hhmm)}</span>
        <span>${esc(s.label||'(no label)')} · ${esc(s.window_mode)}</span>
        <label><input type="checkbox" class="sch-en" data-id="${s.id}" ${s.enabled?'checked':''}> enabled</label>
        <button class="del-btn sch-del" data-id="${s.id}" title="Delete">×</button>
      </div>`).join('');
    box.querySelectorAll('.sch-en').forEach((c) =>
      c.addEventListener('change', async (e) => {
        const s = schedules.find((x) => x.id == e.target.dataset.id);
        try { await api(`/api/schedules/${s.id}`, { method:'PUT',
          body: JSON.stringify({ ...s, enabled: e.target.checked ? 1 : 0 }) }); toast('Saved.'); }
        catch (err) { toast(err.message, true); }
      }));
    box.querySelectorAll('.sch-del').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('Delete this schedule?')) return;
        try { await api(`/api/schedules/${b.dataset.id}`, { method:'DELETE' }); loadSchedules(); toast('Deleted.'); }
        catch (e) { toast(e.message, true); }
      }));
  } catch (e) { $('#scheduleList').innerHTML = `<div class="loading">${e.message}</div>`; }
}

$('#search').addEventListener('input', renderGroups);

// boot: check session
(async () => {
  try { const me = await fetch('/api/me', {credentials:'same-origin'}).then(r=>r.json());
    if (me.authed) showApp(); else showLogin(); }
  catch { showLogin(); }
})();
setInterval(() => {
  if ($('#app').style.display === 'none') return;
  if (view === 'groups') loadGroups();
  else if (view === 'master') loadMasterReports();
}, 30000);
