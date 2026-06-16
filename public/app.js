const $ = (s) => document.querySelector(s);
let groups = [], activeGroup = null, activeName = null;

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, ...opts });
  if (res.status === 401) { showLogin(); throw new Error('Please sign in'); }
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || `HTTP ${res.status}`); }
  return res.json();
}

function toast(msg, err = false) {
  const el = $('#toast'); el.textContent = msg;
  el.className = 'toast show' + (err ? ' err' : '');
  setTimeout(() => { el.className = 'toast' + (err ? ' err' : ''); }, 3500);
}
function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmt(t){ // *bold* -> bold, *Header* lines stay highlighted via b
  return esc(t).replace(/\*(.+?)\*/g, '<b>$1</b>');
}
function timeAgo(u){ const s=Math.floor(Date.now()/1000)-u; if(s<60)return'just now';
  if(s<3600)return Math.floor(s/60)+'m ago'; if(s<86400)return Math.floor(s/3600)+'h ago'; return Math.floor(s/86400)+'d ago'; }
function clock(u){ return new Date(u*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }
function dt(u){ return new Date(u*1000).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}); }

// ---- auth ----
function showLogin(){ $('#login').style.display='flex'; $('#app').style.display='none'; }
function showApp(){ $('#login').style.display='none'; $('#app').style.display='block'; loadGroups(); }

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

// ---- groups ----
async function loadGroups() {
  try {
    const d = await api('/api/groups'); groups = d.groups || [];
    $('#groupCount').textContent = groups.length; $('#statusText').textContent = 'live';
    renderGroups();
  } catch (e) { $('#statusText').textContent = 'error'; }
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
  const today = new Date().toISOString().slice(0,10);
  $('#detail').innerHTML = `
    <div class="detail-head">
      <div><h2>${esc(name)}</h2><div class="sub">${esc(id)}</div></div>
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
  loadReports(id); loadMessages(id);
}

async function loadReports(id) {
  try {
    const { reports } = await api(`/api/groups/${encodeURIComponent(id)}/reports?limit=20`);
    const box = $('#reports');
    const picker = $('#contextPicker');

    if (picker) {
      if (!reports.length) {
        picker.innerHTML = '';
      } else {
        picker.innerHTML =
          '<div class="context-label">Send previous reports as context (optional):</div>' +
          reports.map((r) => `
            <label class="context-item">
              <input type="checkbox" class="ctx" value="${r.id}">
              <span>${dt(r.created_at)} · ${esc(r.window_label || '')}</span>
            </label>`).join('');
      }
    }

    if (!reports.length) { box.innerHTML = '<div class="loading">No reports yet. Run an analysis above.</div>'; return; }
    box.innerHTML = reports.map((r) => `
      <div class="report-card">
        <div class="when"><span>${dt(r.created_at)}</span><span class="trigger">${esc(r.trigger||'')}</span>
          <span>${esc(r.window_label||'')}</span><span>${r.message_count} msgs</span><span>${esc(r.model||'')}</span></div>
        <div class="report-body">${fmt(r.report)}</div>
      </div>`).join('');
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

$('#search').addEventListener('input', renderGroups);

// boot: check session
(async () => {
  try { const me = await fetch('/api/me', {credentials:'same-origin'}).then(r=>r.json());
    if (me.authed) showApp(); else showLogin(); }
  catch { showLogin(); }
})();
setInterval(() => { if ($('#app').style.display !== 'none') loadGroups(); }, 30000);
