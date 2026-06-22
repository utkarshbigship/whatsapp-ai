const $ = (s) => document.querySelector(s);
let groups = [], activeGroup = null, activeName = null;
let view = 'groups', clusters = [];
let progressTimer = null;

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, ...opts });
  if (res.status === 401) { showLogin(); throw new Error('Please sign in'); }
  if (res.status === 202) { const b = await res.json().catch(() => ({})); return { _status: 202, ...b }; }
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || `HTTP ${res.status}`); }
  return res.json();
}

function toast(msg, err = false) {
  const el = $('#toast'); el.textContent = msg;
  el.className = 'toast show' + (err ? ' err' : '');
  setTimeout(() => { el.className = 'toast' + (err ? ' err' : ''); }, 3500);
}
function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function stripTokens(t){ return (t||'').replace(/\{\{G:[^|}]+\|([^}]*)\}\}/g, '$1'); }
function timeAgo(u){ const s=Math.floor(Date.now()/1000)-u; if(s<60)return'just now';
  if(s<3600)return Math.floor(s/60)+'m ago'; if(s<86400)return Math.floor(s/3600)+'h ago'; return Math.floor(s/86400)+'d ago'; }
function clock(u){ return new Date(u*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }
function dt(u){ return new Date(u*1000).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}); }
function todayStr(){ return new Date().toISOString().slice(0,10); }
// datetime-local helpers (local clock, "YYYY-MM-DDTHH:MM")
function pad(n){ return String(n).padStart(2,'0'); }
function nowLocalDT(){ const d=new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function todayStartLocalDT(){ const d=new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T00:00`; }
// Parse a date or datetime-local field value to an IST epoch (seconds).
function istToEpoch(v){ if(!v) return 0; return Math.floor(new Date((v.includes('T')?`${v}:00`:`${v}T00:00:00`)+'+05:30').getTime()/1000); }

// ---------- markdown renderer (no dependency) ----------
const METRIC_LABELS = {
  raised:'Escalations raised', closed:'Closed', pending:'Pending',
  responded_meaningful:'Responded meaningfully', formality_only:'Formality only',
  missed:'No response / missed', high_panic:'High-panic (3+ follow-ups)',
  critical:'Critical', abuse_legal:'Abuse / legal',
  follow_ups_seller:'Seller follow-ups', staff_responses_to_followups:'Staff responses to follow-ups',
  first_mile:'First Mile', last_mile:'Last Mile',
  avg_hours_to_close:'Avg hours to close', avg_days_to_close:'Avg days to close',
  best_case_count:'Best case', worst_case_count:'Worst case', group_count:'Groups',
};
function inline(s, chips){
  let h = esc(s);
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>');
  h = h.replace(/\{\{G:([^|}]+)\|([^}]*)\}\}/g, (m, id, name) => {
    name = (name || '').trim();
    return chips
      ? `<a href="#" class="group-chip" data-gid="${id}" data-gname="${name}">${name || id}</a>`
      : (name || id);
  });
  return h;
}
function renderMetrics(obj, asTable){
  const entries = Object.keys(METRIC_LABELS).filter((k) => obj[k] !== undefined && obj[k] !== null);
  if (!entries.length) return '';
  if (asTable){
    return '<table class="md-table"><tbody>' +
      entries.map((k) => `<tr><td>${esc(METRIC_LABELS[k])}</td><td>${esc(String(obj[k]))}</td></tr>`).join('') +
      '</tbody></table>';
  }
  return '<div class="metrics">' + entries.map((k) =>
    `<div class="metric"><span class="v">${esc(String(obj[k]))}</span><span class="k">${esc(METRIC_LABELS[k])}</span></div>`).join('') + '</div>';
}
function renderTable(rows, chips){
  const parse = (line) => line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map((c) => c.trim());
  const header = parse(rows[0]);
  const body = rows.slice(2).map(parse);
  let h = '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
    header.map((c) => `<th>${inline(c, chips)}</th>`).join('') + '</tr></thead><tbody>';
  for (const r of body) h += '<tr>' + r.map((c) => `<td>${inline(c, chips)}</td>`).join('') + '</tr>';
  return h + '</tbody></table></div>';
}
function renderMarkdown(text, opts = {}){
  const chips = opts.chips !== false;
  const lines = (text || '').split('\n');
  let out = '', i = 0;
  while (i < lines.length){
    const line = lines[i];
    const fence = line.match(/^```(\w*)/);
    if (fence){
      const lang = fence[1]; const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])){ buf.push(lines[i]); i++; }
      i++;
      const content = buf.join('\n').trim();
      if (lang === 'json' || /^\{[\s\S]*\}$/.test(content)){
        try { out += renderMetrics(JSON.parse(content), opts.metricsTable); continue; } catch (_) {}
      }
      out += `<pre class="md-pre">${esc(content)}</pre>`; continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i+1 < lines.length &&
        /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i+1]) && lines[i+1].includes('-')){
      const buf = [line]; i++;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])){ buf.push(lines[i]); i++; }
      out += renderTable(buf, chips); continue;
    }
    const hd = line.match(/^(#{1,4})\s+(.*)$/);
    if (hd){ const lvl = Math.min(Math.max(hd[1].length, 2), 4); out += `<h${lvl} class="md-h">${inline(hd[2], chips)}</h${lvl}>`; i++; continue; }
    if (/^\s*[-*]\s+/.test(line)){
      const buf = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])){ buf.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
      out += '<ul class="md-ul">' + buf.map((b) => `<li>${inline(b, chips)}</li>`).join('') + '</ul>'; continue;
    }
    if (!line.trim()){ i++; continue; }
    const buf = [line]; i++;
    while (i < lines.length && lines[i].trim() &&
           !/^```|^\s*\|.*\|\s*$|^#{1,4}\s+|^\s*[-*]\s+/.test(lines[i])){ buf.push(lines[i]); i++; }
    out += `<p class="md-p">${buf.map((b) => inline(b, chips)).join('<br>')}</p>`;
  }
  return out;
}

// ---------- downloads ----------
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
  const inner = renderMarkdown(text, { chips:false, metricsTable:true });
  const style = `<style>
    body{font-family:Calibri,'Segoe UI',Arial,sans-serif;font-size:11pt;color:#1a1a1a;line-height:1.5}
    h2{font-size:16pt;color:#0b5e2f;border-bottom:1px solid #bbb;padding-bottom:4px;margin:16px 0 8px}
    h3{font-size:13pt;color:#222;margin:14px 0 6px}
    h4{font-size:11.5pt;margin:12px 0 4px}
    p{margin:6px 0}
    table{border-collapse:collapse;width:100%;margin:8px 0}
    th,td{border:1px solid #999;padding:5px 8px;font-size:10pt;text-align:left;vertical-align:top}
    th{background:#eef3f0}
    tr:nth-child(even) td{background:#f7f9f8}
    ul{margin:6px 0 6px 18px}
  </style>`;
  const html = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'>${style}</head><body>${inner}</body></html>`;
  downloadBlob(safeName(name)+'.doc', html, 'application/msword');
}

// ---------- shared report renderer (dropdown + body + downloads) ----------
function renderReportsUI(container, reports, chips){
  if (!reports || !reports.length){ container.innerHTML = '<div class="loading">No reports yet.</div>'; return; }
  const opts = reports.map((r, idx) =>
    `<option value="${idx}">${dt(r.created_at)} · ${esc(r.window_label||'')} · ${esc(r.trigger||'')}</option>`).join('');
  container.innerHTML = `
    <div class="report-toolbar">
      <select class="report-select">${opts}</select>
      <div class="dl-bar">
        <button class="dl-btn2" data-act="md" title="Download raw markdown">⬇ Download .md</button>
        <button class="dl-btn2 primary" data-act="doc" title="Download a clean Word document">⬇ Download Word</button>
      </div>
    </div>
    <div class="report-cards"></div>
    <div class="report-card"><div class="md-report"></div></div>`;
  const sel = container.querySelector('.report-select');
  const body = container.querySelector('.md-report');
  const cards = container.querySelector('.report-cards');
  const cur = () => reports[parseInt(sel.value, 10)] || reports[0];
  const draw = () => {
    const r = cur();
    // Metrics summary cards from the stored counts (master + group reports).
    let m = null;
    if (r.metrics_json) { try { m = JSON.parse(r.metrics_json); } catch (_) {} }
    cards.innerHTML = m ? renderMetrics(m, false) : '';
    body.innerHTML = renderMarkdown(r.report, { chips });
    body.querySelectorAll('.group-chip').forEach((a) =>
      a.addEventListener('click', (e) => { e.preventDefault(); setView('groups'); selectGroup(a.dataset.gid, a.dataset.gname); }));
  };
  sel.addEventListener('change', draw);
  container.querySelectorAll('.dl-btn2').forEach((b) =>
    b.addEventListener('click', () => {
      const r = cur(); const name = `${r.group_name||'report'}_${r.window_label||r.id}`;
      if (b.dataset.act === 'md') downloadMd(r.report, name); else downloadDoc(r.report, name);
    }));
  draw();
}

// ---------- auth ----------
function showLogin(){ $('#login').style.display='flex'; $('#app').style.display='none'; }
function showApp(){ $('#login').style.display='none'; $('#app').style.display='block'; loadGroups(); loadClusters(); }

// show/hide password
$('#togglePass').addEventListener('click', () => {
  const inp = $('#password'), btn = $('#togglePass');
  const reveal = inp.type === 'password';
  inp.type = reveal ? 'text' : 'password';
  btn.classList.toggle('revealed', reveal);
  btn.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
  inp.focus();
});

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#loginErr');
  errEl.textContent = '';
  // Use a direct fetch (not api()) so the 401 isn't swallowed by the generic handler.
  try {
    const res = await fetch('/api/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#username').value, password: $('#password').value }),
    });
    if (res.ok) { errEl.textContent = ''; showApp(); return; }
    if (res.status === 401) errEl.textContent = 'Incorrect username or password';
    else { const b = await res.json().catch(() => ({})); errEl.textContent = b.error || `Error ${res.status}`; }
  } catch (_) {
    errEl.textContent = 'Network error — please try again';
  }
});
$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method:'POST' }).catch(()=>{}); showLogin();
});

// ---------- view switching ----------
function setView(v){
  view = v;
  $('#viewGroups').classList.toggle('active', v==='groups');
  $('#viewMaster').classList.toggle('active', v==='master');
  $('#viewSettings').classList.toggle('active', v==='settings');
  $('#groupsView').style.display = v==='groups' ? '' : 'none';
  $('#masterView').style.display = v==='master' ? 'block' : 'none';
  $('#settingsView').style.display = v==='settings' ? 'block' : 'none';
  if (v==='groups') $('#groupsView').classList.remove('show-detail'); // mobile: land on the list
  if (v==='master') initMasterView();
  if (v==='settings') initSettingsView();
}
$('#viewGroups').addEventListener('click', () => setView('groups'));
$('#viewMaster').addEventListener('click', () => setView('master'));
$('#viewSettings').addEventListener('click', () => setView('settings'));

// ---------- groups ----------
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
  const clusterOpts = clusters.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  $('#detail').innerHTML = `
    <div class="detail-head">
      <button class="back-btn" id="backToList">← Groups</button>
      <div><h2>${esc(name)}</h2><div class="sub">${esc(id)}</div></div>
      <label class="cluster-pick">Cluster <select id="grpCluster" class="date-field">${clusterOpts}</select></label>
    </div>
    <div class="section">
      <h3>Analyse</h3>
      <div class="controls">
        <label>From <input type="datetime-local" id="fromDate" class="date-field" value="${todayStartLocalDT()}"></label>
        <label>To <input type="datetime-local" id="toDate" class="date-field" value="${nowLocalDT()}"></label>
        <label><input type="checkbox" id="last24" checked> last 24h (ignore dates)</label>
        <label><input type="checkbox" id="deliver"> send to WhatsApp</label>
        <button class="btn" id="runBtn">Analyse escalations</button>
      </div>
      <div id="contextPicker" class="context-picker"></div>
    </div>
    <div class="section"><h3>Reports</h3><div id="reports"><div class="loading">Loading…</div></div></div>
    <div class="section"><h3>Recent messages</h3><div id="messages"><div class="loading">Loading…</div></div></div>`;
  $('#runBtn').addEventListener('click', () => runAnalyse(id, name));
  // mobile: swap from the group list to this detail pane, with a way back
  $('#groupsView').classList.add('show-detail');
  $('#backToList').addEventListener('click', () => $('#groupsView').classList.remove('show-detail'));
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
    const { reports } = await api(`/api/groups/${encodeURIComponent(id)}/reports?days=7`);
    const picker = $('#contextPicker');
    if (picker) {
      let suggested = new Set();
      const fromEl = $('#fromDate');
      if (fromEl && fromEl.value && !$('#last24').checked) {
        try {
          const beforeTs = istToEpoch(fromEl.value);
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
    renderReportsUI($('#reports'), reports, true);
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

// ---------- master view ----------
let masterInited = false;
function initMasterView(){
  if (!masterInited) {
    $('#mFromDate').value = todayStartLocalDT(); $('#mToDate').value = nowLocalDT();
    $('#mRunBtn').addEventListener('click', runMasterAnalyse);
    $('#mCluster').addEventListener('change', () => { loadMasterReports(); loadMasterContextPicker(); });
    $('#mFromDate').addEventListener('change', loadMasterContextPicker);
    masterInited = true;
  }
  $('#mCluster').innerHTML = clusters.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  loadMasterReports(); loadMasterContextPicker();
}
function selectedCluster(){ return $('#mCluster').value || 'all'; }
function clusterName(id){ const c = clusters.find((x) => x.id === id); return c ? c.name : id; }

async function loadMasterReports(){
  try {
    const clusterId = selectedCluster();
    const { reports, lock, newSince } = await api(`/api/master/reports?clusterId=${encodeURIComponent(clusterId)}&days=7`);
    const head2 = $('#masterTitle'); if (head2) head2.textContent = `Master report — ${clusterName(clusterId)}`;
    const box = $('#masterReports');
    let head = '';
    if (newSince && newSince.messages > 0) {
      head = `<div class="new-since">⚠ ${newSince.messages} new message${newSince.messages>1?'s':''} from ${newSince.groups} group${newSince.groups>1?'s':''} since this report — re-run to include them.</div>`;
    }
    box.innerHTML = head + '<div class="rep-holder"></div>';
    renderReportsUI(box.querySelector('.rep-holder'), reports, true);
    if (lock && lock.running && !progressTimer) startProgressPolling(clusterId);
  } catch (e) { $('#masterReports').innerHTML = `<div class="loading">${e.message}</div>`; }
}

// Prior master reports (last 7 days) the user can attach as context.
async function loadMasterContextPicker(){
  const picker = $('#mContextPicker'); if (!picker) return;
  try {
    const clusterId = selectedCluster();
    const { reports } = await api(`/api/master/reports?clusterId=${encodeURIComponent(clusterId)}&days=7`);
    let suggested = new Set();
    const fromEl = $('#mFromDate');
    if (fromEl && fromEl.value && !$('#mLast24').checked) {
      try {
        const beforeTs = istToEpoch(fromEl.value);
        const s = await api(`/api/master/context-suggestions?clusterId=${encodeURIComponent(clusterId)}&beforeTs=${beforeTs}&limit=2`);
        (s.suggestions || []).forEach((x) => suggested.add(x.id));
      } catch (_) {}
    }
    picker.innerHTML = !reports.length ? '' :
      '<div class="context-label">Attach previous master reports as context (suggested pre-checked):</div>' +
      reports.map((r) => `
        <label class="context-item">
          <input type="checkbox" class="ctx" value="${r.id}" ${suggested.has(r.id)?'checked':''}>
          <span>${dt(r.created_at)} · ${esc(r.window_label || '')}</span>
        </label>`).join('');
  } catch (_) { picker.innerHTML = ''; }
}

async function runMasterAnalyse(){
  const btn = $('#mRunBtn');
  const clusterId = selectedCluster();
  const body = { clusterId };
  if (!$('#mLast24').checked) { body.fromDate = $('#mFromDate').value; body.toDate = $('#mToDate').value; }
  const ctxIds = Array.from(document.querySelectorAll('#mContextPicker .ctx:checked')).map((c) => parseInt(c.value, 10));
  if (ctxIds.length) body.contextReportIds = ctxIds;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Starting…';
  try {
    const res = await api('/api/master/analyse', { method:'POST', body: JSON.stringify(body) });
    if (res._status === 202) toast('A run is already in progress — showing its progress.');
    startProgressPolling(clusterId);
  } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Analyse all groups'; }
}

function renderProgress(run){
  const panel = $('#masterProgress');
  const total = run.total_groups || 0, done = run.completed_groups || 0;
  const pct = total ? Math.round(done / total * 100) : 0;
  let label, fill = pct;
  if (run.phase === 'master') { label = 'All group reports saved. Aggregating master report…'; fill = 100; }
  else if (run.phase === 'done') { label = 'Done.'; fill = 100; }
  else if (run.phase === 'error') { label = 'Run failed.'; fill = 100; }
  else { label = `Generating group reports… ${done}/${total}${run.current_group ? ' — ' + esc(run.current_group) : ''}`; }
  panel.innerHTML = `<div class="progress-label">${label}</div>
    <div class="progress-bar"><div class="progress-fill ${run.phase==='error'?'err':''}" style="width:${fill}%"></div></div>`;
}

function startProgressPolling(clusterId){
  const panel = $('#masterProgress'); panel.style.display = 'block';
  clearInterval(progressTimer);
  const tick = async () => {
    try {
      const { run } = await api(`/api/master/progress?clusterId=${encodeURIComponent(clusterId)}`);
      if (!run) { panel.style.display = 'none'; clearInterval(progressTimer); progressTimer = null; return; }
      renderProgress(run);
      if (run.status === 'complete' || run.status === 'error') {
        clearInterval(progressTimer); progressTimer = null;
        $('#mRunBtn').disabled = false; $('#mRunBtn').textContent = 'Analyse all groups';
        toast(run.status === 'error' ? ('Run failed: ' + (run.error || '')) : 'Master report ready.', run.status === 'error');
        setTimeout(() => { panel.style.display = 'none'; }, 2500);
        loadMasterReports();
      }
    } catch (_) {}
  };
  tick(); progressTimer = setInterval(tick, 2000);
}

// ---------- settings ----------
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
    const time_hhmm = $('#schTime').value, label = $('#schLabel').value.trim();
    const window_mode = $('#schWindow').value;
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
        <span class="chip">⏰ ${esc(s.time_hhmm)}</span>
        <span>${esc(s.label||'(no label)')} · ${esc(s.window_mode)} → auto master</span>
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
}, 30000);
