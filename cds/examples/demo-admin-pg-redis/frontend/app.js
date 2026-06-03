// Admin dashboard logic. The backend is mounted at /api/ by CDS, so all
// calls are relative — no hard-coded host. Static page, no build step.

const API = '/api';

const el = (id) => document.getElementById(id);

function setConn(ok) {
  const dot = el('conn-dot');
  const text = el('conn-text');
  dot.classList.remove('ok', 'bad');
  if (ok === true) {
    dot.classList.add('ok');
    text.textContent = '后端已连接';
  } else if (ok === false) {
    dot.classList.add('bad');
    text.textContent = '后端不可用';
  } else {
    text.textContent = '连接检测中';
  }
}

function fmtTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function loadHealth() {
  const stat = el('stat-health');
  const meta = el('stat-health-meta');
  try {
    const res = await fetch(`${API}/health`);
    const data = await res.json();
    if (data.ok) {
      stat.textContent = '正常';
      stat.className = 'stat-value ok';
      meta.textContent = 'postgres + redis 已连通';
      setConn(true);
    } else {
      stat.textContent = '降级';
      stat.className = 'stat-value bad';
      meta.textContent = JSON.stringify(data.checks || {});
      setConn(false);
    }
  } catch (error) {
    stat.textContent = '离线';
    stat.className = 'stat-value bad';
    meta.textContent = String(error.message || error);
    setConn(false);
  }
}

async function loadItems() {
  const body = el('items-body');
  try {
    const res = await fetch(`${API}/items`);
    const data = await res.json();
    const items = data.items || [];
    el('stat-items').textContent = String(items.length);
    el('stat-active').textContent = String(
      items.filter((it) => it.status === 'active').length
    );

    if (items.length === 0) {
      body.innerHTML = '<tr><td colspan="4" class="empty">暂无数据，使用上方表单新增第一条</td></tr>';
      return;
    }
    body.innerHTML = items
      .map((it) => {
        const badgeClass = it.status === 'active' ? 'active' : 'paused';
        return `<tr>
          <td class="col-id">${it.id}</td>
          <td>${escapeHtml(it.name)}</td>
          <td><span class="badge ${badgeClass}">${escapeHtml(it.status)}</span></td>
          <td class="col-time">${fmtTime(it.created_at)}</td>
        </tr>`;
      })
      .join('');
  } catch (error) {
    body.innerHTML = `<tr><td colspan="4" class="empty">加载失败: ${escapeHtml(String(error.message || error))}</td></tr>`;
  }
}

async function loadVisits() {
  try {
    const res = await fetch(`${API}/visits`);
    const data = await res.json();
    el('stat-visits').textContent = data.ok ? String(data.visits) : '--';
  } catch (_error) {
    el('stat-visits').textContent = '--';
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function refreshAll() {
  await Promise.all([loadHealth(), loadItems(), loadVisits()]);
}

el('refresh-btn').addEventListener('click', refreshAll);

el('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = el('new-name').value.trim();
  const status = el('new-status').value;
  if (!name) return;
  try {
    const res = await fetch(`${API}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, status }),
    });
    if (res.ok) {
      el('new-name').value = '';
      await Promise.all([loadItems(), loadVisits()]);
    }
  } catch (_error) {
    // surfaced via health card on next refresh
  }
});

// Initial load + a visit increment on each page open.
refreshAll();
