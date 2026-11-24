/**
 * 本地跑通「知识库逐句修改」用的 mock 后端。
 *
 * 目的：在没有真实后端 / 没有账号的情况下，让**真实的前端**完整跑起来——
 * 真实的划词捕获、真实的选区定位、真实的 SSE 流、真实的就地 diff、真实的采纳写回。
 * 只有「数据」和「模型输出」是造的，交互链路一律是产品代码本身。
 *
 * 用法：node mock-kb-server.mjs [port]   （默认 5001，与 vite 的 /api 代理目标一致）
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || 5001);

const STORE_ID = 'store-demo';
const ENTRY_ID = 'entry-demo';

// 造的正文：故意覆盖对抗审计里那几种「页面上看不见的标记」——
// 行内加粗、行内代码、链接、有序列表、代码块，用来在截图里一次看清匹配能力。
let entryContent = `# 真实工作能力评估方案

第一阶段建议至少形成以下成果：

1. 《真实工作能力基准标准》，定义任务来源、任务分级、验证方式、入库和退役规则；
2. 《真实任务制作模板》，统一问题说明、代码版本、环境、验收条件、测试和任务元数据；
3. 《能力评价标准》，统一通过、部分通过、失败以及各能力维度的判断方式。

评估过程中**所有任务都来自真实缺陷库**，调用 \`taskRunner.execute\` 拉起隔离环境，
详细口径见[评估实施细则](https://example.com/spec)。

结尾段落逐字保留，用来确认改写没有越界。
`;

let updatedAt = new Date('2026-08-20T10:00:00Z').toISOString();
/** 记录采纳写回的历史，脚本跑完可以断言「到底写进去了什么」 */
const writeLog = [];

const nowIso = () => new Date().toISOString();

const store = {
  id: STORE_ID,
  name: '产品评估知识库',
  description: '本地 mock 数据',
  ownerId: 'u1',
  tags: ['评估'],
  isPublic: false,
  pinnedEntryIds: [],
  documentCount: 1,
  likeCount: 0,
  viewCount: 0,
  favoriteCount: 0,
  categories: [],
  createdAt: nowIso(),
  updatedAt,
};

const entry = () => ({
  id: ENTRY_ID,
  storeId: STORE_ID,
  isFolder: false,
  title: '真实工作能力评估方案.md',
  summary: '第一阶段成果清单',
  sourceType: 'upload',
  contentType: 'text/markdown',
  fileSize: entryContent.length,
  tags: [],
  metadata: {},
  createdBy: 'u1',
  updatedBy: 'u1',
  updatedByName: '演示用户',
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt,
});

/** 造的「模型输出」：只改选中的那一段，逐字吐出来 */
function fakeRewrite(selectedText, instruction) {
  const s = selectedText.trim();
  if (s.includes('第一阶段建议至少形成以下成果')) {
    return `第一阶段建议至少形成以下可落地成果（从「概念定义」细化到「可执行交付物」）：

1. **《真实工作能力基准标准》V0.1**：明确任务来源分类（缺陷 / 需求 / 事故 / 性能 / 重构），并为每类写出可入库条件；
2. **《真实任务制作模板》V0.1**：固定必填字段——问题背景、目标、代码版本、运行环境、验收标准、隐藏测试说明；
3. **《能力评价标准》V0.1**：给出通过 / 部分通过 / 失败三档的机器判据，逐维度要求证据。`;
  }
  if (s.includes('所有任务都来自真实缺陷库')) {
    return '评估过程中**所有任务均取自线上真实缺陷库**，通过 `taskRunner.execute` 拉起完全隔离的运行环境，详细口径见[评估实施细则](https://example.com/spec)。';
  }
  if (s.includes('《真实任务制作模板》')) {
    return '2. 《真实任务制作模板》，统一问题说明、代码版本、运行环境、验收条件、隐藏测试与任务元数据，确保同一任务可被不同评审复现；';
  }
  return `${s}（已按「${instruction || '润色'}」改写）`;
}

const json = (res, data, code = 200) => {
  const body = JSON.stringify({ success: true, data, error: null });
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
};

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); }
    });
  });
}

async function streamRewrite(req, res) {
  const body = await readBody(req);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send('start', { model: 'mock/demo-writer', platform: 'LocalMock' });
  const text = fakeRewrite(body.selectedText || '', body.instruction);
  let i = 0;
  const timer = setInterval(() => {
    if (i >= text.length) {
      clearInterval(timer);
      send('done', {});
      res.end();
      return;
    }
    const step = 5;
    send('text', { content: text.slice(i, i + step) });
    i += step;
  }, 70);
  req.on('close', () => clearInterval(timer));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;

  if (m === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 划词改写 SSE
  if (m === 'POST' && /\/selection-rewrite$/.test(p)) return streamRewrite(req, res);

  if (p === '/api/document-store/selection-rewrite/actions') {
    return json(res, {
      items: [
        { key: 'polish', label: '润色', description: '提升表达流畅度与专业性' },
        { key: 'concise', label: '精简', description: '压缩冗余表达' },
        { key: 'expand', label: '扩写', description: '补充细节' },
        { key: 'formal', label: '书面化', description: '转为规范书面语' },
        { key: 'fix', label: '纠错', description: '修正错别字与语法' },
      ],
    });
  }

  // 知识库 / 条目
  if (p === '/api/document-store/stores/with-preview' || p === '/api/document-store/stores') {
    return json(res, {
      items: [{
        ...store,
        recentEntries: [{ id: ENTRY_ID, title: entry().title, updatedAt, contentType: 'text/markdown', tags: [] }],
      }],
      total: 1, page: 1, pageSize: 50,
    });
  }
  if (p === `/api/document-store/stores/${STORE_ID}`) return json(res, store);
  if (p === `/api/document-store/stores/${STORE_ID}/entries` && m === 'GET') {
    return json(res, { items: [entry()], total: 1, page: 1, pageSize: 200 });
  }
  if (p === `/api/document-store/entries/${ENTRY_ID}/content`) {
    if (m === 'PUT') {
      const b = await readBody(req);
      entryContent = b.content ?? entryContent;
      updatedAt = nowIso();
      writeLog.push({ at: updatedAt, content: entryContent });
      return json(res, { updated: true, updatedAt, updatedBy: 'u1', updatedByName: '演示用户' });
    }
    return json(res, { content: entryContent, contentType: 'text/markdown', fileUrl: null, hasContent: true });
  }
  if (p === `/api/document-store/entries/${ENTRY_ID}`) return json(res, entry());

  // 测试脚本读「到底写进去了什么」
  if (p === '/__mock/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ content: entryContent, writes: writeLog.length, lastWrite: writeLog.at(-1) ?? null }));
    return;
  }

  // 鉴权 / 外壳
  if (p === '/api/authz/me') {
    return json(res, {
      userId: 'u1', username: 'demo', displayName: '演示用户', isRoot: true,
      effectivePermissions: ['access', 'document-store.read', 'document-store.write'],
      menuCatalog: [], cdnBaseUrl: '', permFingerprint: 'mock',
    });
  }
  if (p === '/api/v1/auth/login' && m === 'POST') {
    return json(res, {
      accessToken: 'mock-token', refreshToken: 'mock-refresh', sessionKey: 'mock-session',
      user: { userId: 'u1', username: 'demo', displayName: '演示用户', role: 'ADMIN' },
    });
  }

  // 双链面板：字段缺一个就整页 ErrorBoundary，必须给全
  if (/\/api\/mentions\/documents\/.+\/links$/.test(p)) {
    return json(res, { backlinks: [], forwardLinks: [], backlinksCount: 0, forwardLinksCount: 0 });
  }
  if (/\/api\/mentions\//.test(p)) return json(res, { nodes: [], edges: [], items: [] });

  // 其余端点一律给「空但合法」的返回，避免外壳因为某个副链路报错而卡住
  if (/inline-comments/.test(p)) return json(res, { items: [], canCreate: true, isOwner: true, viewerUserId: 'u1' });
  if (/\/versions/.test(p)) return json(res, { items: [] });
  if (m === 'GET') return json(res, { items: [], total: 0 });
  return json(res, {});
});

server.listen(PORT, () => {
  console.log(`[mock-kb] listening on http://127.0.0.1:${PORT}`);
});
