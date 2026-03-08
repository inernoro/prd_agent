#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Mock Paginated API Server
// 用于测试 smart-http 舱的增强功能：
//   - cursor 分页
//   - 自定义 dataPath (response.result.list)
//   - offset 分页
//   - page 分页
//   - POST body 分页
//
// 启动: node scripts/mock-paginated-api.js [port]
// 默认端口: 7799
// ═══════════════════════════════════════════════════════════════

const http = require('http');
const url = require('url');

const PORT = parseInt(process.argv[2]) || 7799;

// 生成 50 条模拟数据
const ALL_ITEMS = Array.from({ length: 50 }, (_, i) => ({
  id: `item-${String(i + 1).padStart(3, '0')}`,
  title: `Task #${i + 1}`,
  status: ['open', 'in_progress', 'done', 'closed'][i % 4],
  priority: ['P0', 'P1', 'P2', 'P3'][i % 4],
  assignee: ['Alice', 'Bob', 'Charlie', 'Diana'][i % 4],
  createdAt: new Date(2026, 2, 1 + (i % 28)).toISOString().slice(0, 10),
}));

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;
  const query = parsed.query;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── 1) Cursor 分页 (GET /api/cursor-list) ──
  // 响应格式: { response: { result: { list: [...] } }, paging: { next_cursor: "..." } }
  // 用于测试 dataPath="response.result.list" + cursor 分页
  if (path === '/api/cursor-list' && req.method === 'GET') {
    const cursor = query.cursor || '0';
    const limit = parseInt(query.limit) || 10;
    const startIdx = parseInt(cursor);

    const page = ALL_ITEMS.slice(startIdx, startIdx + limit);
    const hasMore = startIdx + limit < ALL_ITEMS.length;

    return jsonResponse(res, {
      response: {
        result: {
          list: page,
          total: ALL_ITEMS.length,
        },
      },
      paging: {
        current_cursor: cursor,
        next_cursor: hasMore ? String(startIdx + limit) : null,
        has_more: hasMore,
      },
    });
  }

  // ── 2) Offset 分页 (GET /api/offset-list) ──
  // 响应格式: { data: [...], total: N }
  if (path === '/api/offset-list' && req.method === 'GET') {
    const offset = parseInt(query.offset) || 0;
    const limit = parseInt(query.limit) || 10;
    const page = ALL_ITEMS.slice(offset, offset + limit);

    return jsonResponse(res, {
      data: page,
      total: ALL_ITEMS.length,
      offset,
      limit,
    });
  }

  // ── 3) Page 分页 (GET /api/page-list) ──
  // 响应格式: { items: [...], pageInfo: { page, pageSize, totalPages } }
  if (path === '/api/page-list' && req.method === 'GET') {
    const page = parseInt(query.page) || 1;
    const pageSize = parseInt(query.pageSize) || 10;
    const startIdx = (page - 1) * pageSize;
    const items = ALL_ITEMS.slice(startIdx, startIdx + pageSize);

    return jsonResponse(res, {
      items,
      pageInfo: {
        page,
        pageSize,
        totalPages: Math.ceil(ALL_ITEMS.length / pageSize),
        total: ALL_ITEMS.length,
      },
    });
  }

  // ── 4) POST Body 分页 (POST /api/search) ──
  // 请求 body: { query: "...", pageIndex: 1, pageSize: 10 }
  // 响应格式: { result: { records: [...] }, pagination: { next_cursor: "..." } }
  if (path === '/api/search' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const params = JSON.parse(body);
        const pageIndex = params.pageIndex || 1;
        const pageSize = params.pageSize || 10;
        const startIdx = (pageIndex - 1) * pageSize;
        const records = ALL_ITEMS.slice(startIdx, startIdx + pageSize);
        const hasMore = startIdx + pageSize < ALL_ITEMS.length;

        jsonResponse(res, {
          result: {
            records,
            total: ALL_ITEMS.length,
          },
          pagination: {
            current_page: pageIndex,
            next_cursor: hasMore ? String(pageIndex + 1) : null,
            has_more: hasMore,
          },
        });
      } catch {
        jsonResponse(res, { error: 'Invalid JSON body' }, 400);
      }
    });
    return;
  }

  // ── 5) 故意慢 + 偶尔失败 (GET /api/flaky) ──
  // 用于测试 retry + delay
  if (path === '/api/flaky' && req.method === 'GET') {
    const failRate = parseFloat(query.fail_rate) || 0.3;
    const delayMs = parseInt(query.delay_ms) || 500;

    setTimeout(() => {
      if (Math.random() < failRate) {
        return jsonResponse(res, { error: 'Random failure for testing' }, 503);
      }
      const page = parseInt(query.page) || 1;
      const pageSize = parseInt(query.pageSize) || 10;
      const startIdx = (page - 1) * pageSize;
      const items = ALL_ITEMS.slice(startIdx, startIdx + pageSize);
      jsonResponse(res, { data: items, page, total: ALL_ITEMS.length });
    }, delayMs);
    return;
  }

  // ── 6) 健康检查 ──
  if (path === '/health') {
    return jsonResponse(res, {
      status: 'ok',
      endpoints: [
        'GET  /api/cursor-list?cursor=0&limit=10  — cursor pagination + nested dataPath',
        'GET  /api/offset-list?offset=0&limit=10  — offset pagination',
        'GET  /api/page-list?page=1&pageSize=10   — page pagination',
        'POST /api/search {pageIndex,pageSize}     — POST body pagination',
        'GET  /api/flaky?page=1&fail_rate=0.3      — flaky endpoint for retry testing',
      ],
      totalItems: ALL_ITEMS.length,
    });
  }

  // 404
  jsonResponse(res, { error: 'Not found', hint: 'Try GET /health' }, 404);
});

server.listen(PORT, () => {
  console.log(`\n  Mock Paginated API running on http://localhost:${PORT}`);
  console.log(`  Health check: http://localhost:${PORT}/health`);
  console.log(`\n  Endpoints:`);
  console.log(`    GET  /api/cursor-list?cursor=0&limit=10  (cursor + dataPath test)`);
  console.log(`    GET  /api/offset-list?offset=0&limit=10  (offset pagination)`);
  console.log(`    GET  /api/page-list?page=1&pageSize=10   (page pagination)`);
  console.log(`    POST /api/search {pageIndex, pageSize}   (POST body pagination)`);
  console.log(`    GET  /api/flaky?page=1&fail_rate=0.3     (retry test)`);
  console.log(`\n  Total mock items: ${ALL_ITEMS.length}`);
  console.log(`  Press Ctrl+C to stop\n`);
});
