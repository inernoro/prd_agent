// Polls the backend for processed messages and lets the user publish new
// ones. Backend is mounted at /api/ by CDS, so calls are relative.

const API = '/api';
const el = (id) => document.getElementById(id);

function setBroker(state) {
  const pill = el('broker-pill');
  pill.classList.remove('ok', 'bad');
  if (state === 'connected') {
    pill.classList.add('ok');
    pill.textContent = 'RabbitMQ 已连接';
  } else if (state === 'down') {
    pill.classList.add('bad');
    pill.textContent = '后端不可用';
  } else {
    pill.textContent = 'RabbitMQ 连接中';
  }
}

function fmtTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function poll() {
  try {
    const [health, list] = await Promise.all([
      fetch(`${API}/health`).then((r) => r.json()),
      fetch(`${API}/messages`).then((r) => r.json()),
    ]);
    setBroker(health.broker === 'connected' ? 'connected' : 'connecting');

    const messages = list.messages || [];
    el('count').textContent = `${messages.length} 条`;
    if (messages.length === 0) {
      el('msg-list').innerHTML = '<li class="empty">还没有消息，先发送一条试试</li>';
    } else {
      el('msg-list').innerHTML = messages
        .map(
          (m) => `<li>
            <span class="msg-text">${escapeHtml(m.text)}</span>
            <span class="msg-time">${fmtTime(m.at)}</span>
          </li>`
        )
        .join('');
    }
  } catch (_error) {
    setBroker('down');
  }
}

el('send-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = el('msg-input');
  const text = input.value.trim();
  const hint = el('send-hint');
  if (!text) return;
  try {
    const res = await fetch(`${API}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (res.ok) {
      input.value = '';
      hint.className = 'hint';
      hint.textContent = '已投递，等待消费者处理（通常在 1 秒内回显）。';
      setTimeout(poll, 400);
    } else {
      const data = await res.json().catch(() => ({}));
      hint.className = 'hint bad';
      hint.textContent = `投递失败: ${data.error || res.status}`;
    }
  } catch (error) {
    hint.className = 'hint bad';
    hint.textContent = `投递失败: ${error.message || error}`;
  }
});

poll();
setInterval(poll, 2000);
