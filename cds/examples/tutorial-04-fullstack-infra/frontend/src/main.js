const output = document.querySelector('#output');
const cards = document.querySelector('#cards');
const refresh = document.querySelector('#refresh');

function render(data) {
  output.textContent = JSON.stringify(data, null, 2);
  cards.innerHTML = '';
  for (const check of data.checks || []) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="label">${check.label}</div>
      <div class="value">${check.ok ? '通过' : '失败'}</div>
    `;
    cards.appendChild(card);
  }
}

async function load() {
  output.textContent = '正在请求 /api/health ...';
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    render(data);
  } catch (error) {
    output.textContent = error instanceof Error ? error.message : String(error);
  }
}

refresh.addEventListener('click', () => {
  void load();
});

void load();
