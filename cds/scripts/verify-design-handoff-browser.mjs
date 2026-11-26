import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const runnerPath = process.argv.includes('--source')
  ? '../src/services/design-handoff-browser.ts'
  : '../dist/services/design-handoff-browser.js';
const { runDesignHandoff } = await import(runnerPath);

function testAudio() {
  const samples = 16_000;
  const audio = Buffer.alloc(44 + samples * 2);
  audio.write('RIFF');
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8_000, 24);
  audio.writeUInt32LE(16_000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(samples * 2, 40);
  for (let sample = 0; sample < samples; sample++) {
    audio.writeInt16LE(Math.round(2_000 * Math.sin(2 * Math.PI * 330 * sample / 8_000)), 44 + sample * 2);
  }
  return 'data:audio/wav;base64,' + audio.toString('base64');
}

function prototype(defects = false) {
  return Buffer.from([
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>交接门禁合成用例</title>',
    '<main>',
    '<section data-screen="records" hidden>',
    '<button type="button" class="record" data-id="record-alpha" id="alpha">渡口</button>',
    '<button type="button" class="record" data-id="record-beta" id="beta">林间</button>',
    '<output id="detail" data-id="">请先选择</output></section>',
    '<section data-screen="retry" hidden>',
    '<output id="complete" data-state="completed" data-revision="3">摘要三</output>',
    '<output id="interrupted" data-state="failed">待恢复</output>',
    '<button type="button" id="retry">重试</button></section>',
    '<section data-screen="inputs" hidden>',
    '<label for="alternate">备用输入</label><textarea id="alternate"></textarea>',
    '<button type="button" id="use-sample">使用样例</button>',
    '<button type="button" id="submit" disabled>确认</button><output id="result">等待输入</output></section>',
    '<section data-screen="media" hidden>',
    '<button type="button" id="play">播放</button><output id="playback">等待</output>',
    '<audio id="track" controls' + (defects ? '' : ' src="' + testAudio() + '"') + '></audio></section>',
    '<section data-screen="expand" hidden>',
    '<button type="button" id="full">全屏</button><button type="button" id="expand">展开内容</button>',
    '<div id="canvas" data-state="compact">样例内容</div></section></main>',
    '<script>',
    'const defects = ' + JSON.stringify(defects) + ';',
    'const byId = id => document.getElementById(id);',
    'const screen = location.hash.slice(2);',
    'document.querySelectorAll("section[data-screen]").forEach(section => {',
    '  section.hidden = section.dataset.screen !== screen;',
    '});',
    'document.querySelector("main").dataset.ready = screen;',
    'document.querySelectorAll(".record").forEach(record => record.addEventListener("click", () => {',
    '  setTimeout(() => {',
    '    const selected = defects ? byId("alpha") : record;',
    '    byId("detail").dataset.id = selected.dataset.id;',
    '    byId("detail").textContent = selected.textContent;',
    '  }, 35);',
    '}));',
    'byId("retry").addEventListener("click", () => {',
    '  byId("interrupted").dataset.state = "running";',
    '  if (defects) {',
    '    byId("complete").dataset.state = "waiting";',
    '    byId("complete").dataset.revision = "0";',
    '    byId("complete").textContent = "待生成";',
    '  }',
    '});',
    'byId("alternate").addEventListener("input", () => {',
    '  byId("submit").disabled = defects || !byId("alternate").value.trim();',
    '});',
    'byId("use-sample").addEventListener("click", () => {',
    '  byId("alternate").value = "样例稿件";',
    '  byId("submit").disabled = false;',
    '});',
    'byId("submit").addEventListener("click", () => {',
    '  byId("result").dataset.request = crypto.randomUUID();',
    '  byId("result").textContent = "已接收";',
    '});',
    'byId("play").addEventListener("click", () => {',
    '  byId("playback").textContent = "00:01";',
    '  if (!defects) void byId("track").play().catch(() => {});',
    '});',
    'byId("full").addEventListener("click", () => {',
    '  void byId("canvas").requestFullscreen().catch(() => {});',
    '});',
    'byId("expand").addEventListener("click", () => { byId("canvas").dataset.state = "expanded"; });',
    '</script></html>',
  ].join('\n'));
}

const fixtures = [
  ['records', '对象导航', 'desktop'],
  ['retry', '局部重试', 'desktop'],
  ['inputs', '备用输入', 'phone'],
  ['media', '播放', 'desktop'],
  ['expand', '预览容器', 'desktop'],
];
const screens = fixtures.map(([id, name, viewport]) => ({
  id,
  name,
  viewport,
  route: '#/' + id,
  themes: ['light', 'dark'],
  impl: null,
  entryReadySelector: '[data-ready="' + id + '"]',
}));

const inspect = (selector, check, equals) => ({ action: 'expect', selector, check, equals });
const click = selector => ({ action: 'click', selector });
const remember = (selector, attribute, as) => ({ action: 'remember', selector, check: 'attribute', attribute, as });
const unchanged = (selector, attribute, sameAs) => ({ action: 'expect', selector, check: 'attribute', attribute, sameAs });
const attribute = (selector, name, equals) => ({ action: 'expect', selector, check: 'attribute', attribute: name, equals });

const cases = [
  {
    id: 'record-identity', title: '打开的详情和所选对象一致', screenId: 'records', ruleIds: ['A-01'], theme: 'light',
    steps: [
      remember('#beta', 'data-id', 'selected-record'),
      click('#beta'),
      unchanged('#detail', 'data-id', 'selected-record'),
      inspect('#detail', 'text', '林间'),
    ],
  },
  {
    id: 'retry-keeps-completed', title: '重试保留已完成的结果', screenId: 'retry', ruleIds: ['A-02'], theme: 'light',
    steps: [
      attribute('#complete', 'data-state', 'completed'),
      remember('#complete', 'data-revision', 'completed-revision'),
      attribute('#interrupted', 'data-state', 'failed'),
      click('#retry'),
      attribute('#interrupted', 'data-state', 'running'),
      attribute('#complete', 'data-state', 'completed'),
      unchanged('#complete', 'data-revision', 'completed-revision'),
      inspect('#complete', 'text', '摘要三'),
    ],
  },
  {
    id: 'use-alternate-input', title: '备用输入独立完成主流程', screenId: 'inputs', ruleIds: ['A-03'], theme: 'dark',
    steps: [
      inspect('#submit', 'enabled', false),
      { action: 'fill', selector: '#alternate', value: '从页面录入的一段样例稿件' },
      inspect('#alternate', 'value', '从页面录入的一段样例稿件'),
      inspect('#submit', 'enabled', true),
      click('#submit'),
      inspect('#result', 'text', '已接收'),
    ],
  },
  {
    id: 'use-sample-input', title: '样例入口仍能提交', screenId: 'inputs', ruleIds: ['A-03'], theme: 'light',
    steps: [click('#use-sample'), inspect('#submit', 'enabled', true), click('#submit'), inspect('#result', 'text', '已接收')],
  },
  {
    id: 'audio-through-embed', title: '浏览器播放合成音轨', screenId: 'media', ruleIds: ['A-04'], theme: 'light',
    steps: [click('#play'), inspect('#playback', 'text', '00:01'), inspect('#track', 'audio-playing', true)],
  },
  {
    id: 'native-fullscreen', title: '独立核对宿主全屏许可', screenId: 'expand', ruleIds: ['A-05'], theme: 'light',
    steps: [click('#full'), inspect('#canvas', 'fullscreen', true)],
  },
  {
    id: 'expand-content', title: '容器内可展开内容', screenId: 'expand', ruleIds: ['A-05'], theme: 'light',
    steps: [click('#expand'), attribute('#canvas', 'data-state', 'expanded')],
  },
];

const executablePath = process.env.CDS_CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch({ headless: true, executablePath });
try {
  const good = await runDesignHandoff(browser, { prototype: prototype(), screens, cases });
  const bad = await runDesignHandoff(browser, { prototype: prototype(true), screens, cases });
  for (const results of [good, bad]) {
    assert.deepEqual(results.map(row => row.caseId).sort(), cases.map(row => row.id).sort());
  }
  const lookup = (rows, id) => rows.find(row => row.caseId === id);
  const requireStatus = (rows, id, status) => {
    const actual = lookup(rows, id);
    assert.equal(actual.status, status, JSON.stringify(actual));
  };
  const broken = {
    'record-identity': 3,
    'retry-keeps-completed': 6,
    'use-alternate-input': 4,
    'audio-through-embed': 3,
  };
  for (const [id, step] of Object.entries(broken)) {
    requireStatus(bad, id, 'failed');
    assert.equal(lookup(bad, id).code, 'expectation');
    assert.equal(lookup(bad, id).step, step);
  }
  for (const id of [...Object.keys(broken), 'use-sample-input', 'expand-content']) requireStatus(good, id, 'passed');
  for (const id of ['use-sample-input', 'expand-content']) requireStatus(bad, id, 'passed');
  for (const results of [good, bad]) {
    requireStatus(results, 'native-fullscreen', 'unavailable');
    assert.equal(lookup(results, 'native-fullscreen').code, 'host-capability');
  }
  const summarize = rows => rows.map(({ caseId, status, step, code }) => ({ caseId, status, step, code }));
  console.log(JSON.stringify({ good: summarize(good), bad: summarize(bad) }, null, 2));
} finally {
  await browser.close();
}
