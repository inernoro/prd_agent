import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readProjectCredentials, MAX_ZIP_BYTES, TOOLS } from '../src/bridge.mjs';

const serverPath = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
let root;
let server;
let host;
const requests = [];
const key = 'cdsp_test_not_a_real_credential';
const task = { id: 'task-1', projectId: 'project-one', status: 'running', reportId: 'report-1' };
const completeCatalog = TOOLS.map((tool) => tool.name);
let catalog = completeCatalog;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-review-mcp-'));
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, '.cds'));
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, 'code.zip'), Buffer.from('PK\x03\x04test-archive'));
  await fs.writeFile(path.join(root, 'review.md'), '# review evidence');
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('content-type', 'application/json');
    if (req.headers['x-ai-access-key'] !== key) { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/api/code-reviews/capabilities') {
      res.end(JSON.stringify({ engineConfigured: true, mailConfigured: false, storageConfigured: true, tools: catalog }));
      return;
    }
    if (req.url.includes('redirect')) { res.writeHead(302, { location: host + '/credential-sink' }); res.end('{}'); return; }
    if (url.pathname.endsWith('/wrong-result-project') || url.pathname.endsWith('/wrong-result-task')) {
      res.end(JSON.stringify({ task: { ...task, id: url.pathname.split('/').at(-1) },
        result: { projectId: url.pathname.endsWith('/wrong-result-project') ? 'other' : task.projectId, taskId: 'another-task' } })); return;
    }
    if (url.pathname.endsWith('/loading-task')) { res.end(JSON.stringify({ task: { ...task, id: 'loading-task', status: 'failed' }, result: null, resultLoading: true })); return; }
    if (url.pathname.endsWith('/wrong-project')) { res.end(JSON.stringify({ task: { ...task, projectId: 'other' } })); return; }
    if (url.pathname.endsWith('/secret-error')) { res.writeHead(502); res.end(JSON.stringify({ message: `upstream ${key} SMTP_PASSWORD=private-password` })); return; }
    if (req.url.endsWith('/reports')) { res.end(JSON.stringify({ report: { id: 'report-1', projectId: 'project-one', reportType: 'code-review' } })); return; }
    if (url.pathname === '/api/code-reviews/branches') { res.end(JSON.stringify({ branches: [{ id: 'branch-1', branch: 'feature/audit', status: 'idle' }] })); return; }
    if (url.searchParams.has('projectId')) { res.end(JSON.stringify({ tasks: [task] })); return; }
    if (url.searchParams.has('includeResult')) {
      res.end(JSON.stringify({ task, result: { taskId: task.id, projectId: task.projectId,
        findings: [{ filePath: 'src/a.ts', severity: 'high', message: '原始问题', verified: false }],
        coverage: { totalFiles: 10, scannedFiles: 4, complete: false }, page: { offset: Number(url.searchParams.get('offset') || 0), nextOffset: 50 } },
        reportUrl: host + '/code-reviews?project=project-one&task=task-1&report=1' })); return;
    }
    res.writeHead(req.method === 'POST' ? 202 : 200);
    res.end(JSON.stringify({ task }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  host = `http://127.0.0.1:${server.address().port}`;
  await fs.writeFile(path.join(root, '.cds/credentials.json'), JSON.stringify({ version: 1, host, projectId: 'project-one', projectKey: key }));
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
});

async function withClient(callback) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [serverPath], cwd: path.join(root, 'nested'), stderr: 'pipe',
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' },
  });
  const client = new Client({ name: 'cds-code-review-test', version: '1.0.0' });
  try { await client.connect(transport); return await callback(client); }
  finally { await client.close(); }
}
const parsed = (result) => JSON.parse(result.content[0].text);

test('real stdio client discovers and calls all four project-scoped tools', async () => {
  await withClient(async (client) => {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((tool) => tool.name), ['cds_code_review_submit', 'cds_code_review_get', 'cds_code_review_list', 'cds_code_review_report_upload']);
    assert.equal(tools.find((tool) => tool.name === 'cds_code_review_get').annotations.readOnlyHint, true);
    assert.equal(tools[0].annotations.destructiveHint, false);
    assert.deepEqual(parsed(await client.callTool({ name: 'cds_code_review_list', arguments: {} })), { tasks: [task] });
    const read = parsed(await client.callTool({ name: 'cds_code_review_get', arguments: { taskId: 'task-1', offset: 50, severity: 'high' } }));
    assert.deepEqual(read.task, task); assert.equal(read.result.coverage.complete, false);
    assert.equal(read.result.findings[0].filePath, 'src/a.ts'); assert.equal(read.result.findings[0].verified, false);
    assert.equal(read.result.page.offset, 50); assert.ok(read.reportUrl.includes('task=task-1'));
    assert.ok(requests.at(-1).url.includes('includeResult=1')); assert.ok(requests.at(-1).url.includes('severity=high'));
    const submitted = await client.callTool({ name: 'cds_code_review_submit', arguments: { githubUrl: 'https://github.com/inernoro/prd_agent', ref: 'main', email: 'owner@example.com', idempotencyKey: 'same-submission' } });
    assert.equal(submitted.isError, undefined);
    assert.equal(parsed(submitted).task.id, 'task-1');
    const request = requests.at(-1);
    assert.deepEqual(JSON.parse(request.body), { projectId: 'project-one', sourceType: 'github', githubUrl: 'https://github.com/inernoro/prd_agent', ref: 'main', email: 'owner@example.com', idempotencyKey: 'same-submission' });
    assert.equal(request.headers['x-ai-access-key'], key);
    const zip = await client.callTool({ name: 'cds_code_review_submit', arguments: { zipPath: 'code.zip', excludePatterns: ['vendor/**'] } });
    assert.equal(zip.isError, undefined);
    assert.match(requests.at(-1).headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.match(requests.at(-1).body, /name="projectId"\r\n\r\nproject-one/);
    assert.match(requests.at(-1).body, /filename="code.zip"/);
    assert.match(requests.at(-1).body, /vendor\/\*\*/);
    const report = await client.callTool({ name: 'cds_code_review_report_upload', arguments: { filePath: 'review.md', title: '质量审查' } });
    assert.equal(report.isError, undefined);
    assert.equal(parsed(report).report.reportType, 'code-review');
    assert.match(requests.at(-1).body, /# review evidence/);
    assert.match(requests.at(-1).body, /name="format"\r\n\r\nmd/);
  });
});

test('rejects project overrides, mismatched responses, ambiguous inputs and non-GitHub URLs', async () => {
  await withClient(async (client) => {
    await client.listTools();
    let count = requests.length;
    const override = await client.callTool({ name: 'cds_code_review_list', arguments: { projectId: 'other' } });
    assert.equal(override.isError, true);
    assert.equal(requests.length, count);
    for (const args of [{}, { zipPath: 'code.zip', githubUrl: 'https://github.com/a/b' }, { branchId: 'branch-1', githubUrl: 'https://github.com/a/b' }, { branchId: 'branch-1', zipPath: 'code.zip' }, { branchId: 'branch-1', ref: 'main' }, { githubUrl: 'http://localhost/private' }, { githubUrl: 'https://user:pass@github.com/a/b' }]) {
      const result = await client.callTool({ name: 'cds_code_review_submit', arguments: args });
      assert.equal(result.isError, true);
    }
    assert.equal(requests.length, count);
    const mismatched = await client.callTool({ name: 'cds_code_review_get', arguments: { taskId: 'wrong-project' } });
    assert.equal(mismatched.isError, true);
    assert.match(mismatched.content[0].text, /项目不匹配/);
  });
});

test('real stdio client discovers CDS branches and submits one without local files or repository URLs', async () => {
  await withClient(async client => {
    const listed = parsed(await client.callTool({ name: 'cds_code_review_list', arguments: { includeBranches: true } }));
    assert.deepEqual(listed.tasks, [task]);
    assert.deepEqual(listed.branches, [{ id: 'branch-1', branch: 'feature/audit', status: 'idle' }]);
    assert.equal(requests.at(-1).url, '/api/code-reviews/branches?projectId=project-one');
    const response = await client.callTool({ name: 'cds_code_review_submit', arguments: { branchId: listed.branches[0].id, excludePatterns: ['vendor/'], title: '所选分支' } });
    assert.equal(response.isError, undefined);
    assert.deepEqual(JSON.parse(requests.at(-1).body), { sourceType: 'cds', projectId: 'project-one', branchId: 'branch-1', excludePatterns: ['vendor/'], title: '所选分支' });
  });
});

test('rejects external files and symlink escapes before sending HTTP', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-mcp-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'secret.md'), 'must not upload');
    await fs.symlink(path.join(outside, 'secret.md'), path.join(root, 'escape.md'));
    await withClient(async (client) => {
      await client.listTools();
      const count = requests.length;
      for (const filePath of [path.join(outside, 'secret.md'), 'escape.md', '.cds/credentials.json']) {
        const result = await client.callTool({ name: 'cds_code_review_report_upload', arguments: { filePath, title: 'forbidden' } });
        assert.equal(result.isError, true);
        assert.doesNotMatch(result.content[0].text, /must not upload/);
      }
      assert.equal(requests.length, count);
    });
  } finally { await fs.rm(outside, { recursive: true, force: true }); }
});

test('oversized ZIP is refused without reading or uploading it', async () => {
  const handle = await fs.open(path.join(root, 'large.zip'), 'w');
  await handle.truncate(MAX_ZIP_BYTES + 1);
  await handle.close();
  await withClient(async (client) => {
    await client.listTools();
    const count = requests.length;
    const result = await client.callTool({ name: 'cds_code_review_submit', arguments: { zipPath: 'large.zip' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /100 MiB/);
    assert.equal(requests.length, count);
  });
});

test('backend capability subset controls both tools/list and tools/call', async () => {
  catalog = ['cds_code_review_get', 'cds_code_review_list'];
  try {
    await withClient(async (client) => {
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), catalog);
      const count = requests.length;
      const result = await client.callTool({ name: 'cds_code_review_submit', arguments: { githubUrl: 'https://github.com/inernoro/prd_agent' } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /能力目录未开放/);
      assert.equal(requests.length, count);
      assert.deepEqual(parsed(await client.callTool({ name: 'cds_code_review_list', arguments: {} })), { tasks: [task] });
    });
  } finally { catalog = completeCatalog; }
});

test('missing, unknown or duplicate backend catalog fails closed for discovery and calls', async () => {
  for (const invalid of [undefined, 'all', ['execute_shell'], ['cds_code_review_get', 'cds_code_review_get']]) {
    catalog = invalid;
    try {
      await withClient(async (client) => {
        await assert.rejects(client.listTools(), /能力目录无效/);
        const count = requests.length;
        const result = await client.callTool({ name: 'cds_code_review_get', arguments: { taskId: 'task-1' } });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /能力目录无效/);
        assert.equal(requests.length, count + 1);
        assert.equal(requests.at(-1).url, '/api/code-reviews/capabilities');
      });
    } finally { catalog = completeCatalog; }
  }
});

test('an invalid catalog refresh revokes previously discovered tools', async () => {
  await withClient(async (client) => {
    await client.listTools();
    catalog = ['unknown_tool'];
    try {
      await assert.rejects(client.listTools(), /能力目录无效/);
      const result = await client.callTool({ name: 'cds_code_review_get', arguments: { taskId: 'task-1' } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /能力目录无效/);
    } finally { catalog = completeCatalog; }
  });
});

test('does not follow redirects and redacts upstream credential echoes', async () => {
  await withClient(async (client) => {
    const redirected = await client.callTool({ name: 'cds_code_review_get', arguments: { taskId: 'redirect' } });
    assert.equal(redirected.isError, true);
    assert.equal(requests.some((request) => request.url === '/credential-sink'), false);
    const result = await client.callTool({ name: 'cds_code_review_get', arguments: { taskId: 'secret-error' } });
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content[0].text, new RegExp(key));
    assert.doesNotMatch(result.content[0].text, /private-password/);
    assert.match(result.content[0].text, /HTTP 502/);
  });
});

test('workspace credentials schema is strict, ignores env overrides, and requires project key', async () => {
  const credential = await readProjectCredentials(path.join(root, 'nested'));
  assert.equal(credential.host, host);
  assert.equal(credential.projectId, 'project-one');
  const another = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-mcp-invalid-'));
  try {
    await fs.mkdir(path.join(another, '.cds'));
    for (const payload of [
      { version: 1, host, bootstrapKey: 'global-key' },
      { version: 1, host: 'https://user:password@example.com', projectId: 'p', projectKey: key },
      { version: 1, host: 'http://remote.example.com', projectId: 'p', projectKey: key },
    ]) {
      await fs.writeFile(path.join(another, '.cds/credentials.json'), JSON.stringify(payload));
      await assert.rejects(readProjectCredentials(another));
    }
  } finally { await fs.rm(another, { recursive: true, force: true }); }
});


test('structured results reject cross-project/task responses and invalid paging before requests', async () => {
  await withClient(async client => {
    await client.listTools();
    for (const taskId of ['wrong-result-project', 'wrong-result-task']) {
      assert.equal((await client.callTool({ name: 'cds_code_review_get', arguments: { taskId } })).isError, true);
    }
    const count = requests.length;
    for (const args of [{ offset: -1 }, { limit: 101 }, { limit: 0 }, { severity: 'unknown' }]) {
      assert.equal((await client.callTool({ name: 'cds_code_review_get', arguments: { taskId: 'task-1', ...args } })).isError, true);
    }
    assert.equal(requests.length, count);
  });
});


test('cold historical results remain pollable without retrying a review', async () => {
  await withClient(async client => {
    await client.listTools();
    const response = await client.callTool({ name: 'cds_code_review_get', arguments: { taskId: 'loading-task' } });
    assert.equal(response.isError, undefined); assert.equal(parsed(response).resultLoading, true);
    assert.equal(parsed(response).task.status, 'failed'); assert.equal(requests.at(-1).method, 'GET');
  });
});
