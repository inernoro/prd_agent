import fs from 'node:fs/promises';
import path from 'node:path';
import { fetch, FormData, EnvHttpProxyAgent } from 'undici';
import { z } from 'zod';

export const MAX_ZIP_BYTES = 100 * 1024 * 1024;
export const MAX_REPORT_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const id = z.string().trim().min(1).max(200);
const common = {
  title: z.string().trim().min(1).max(300).optional(),
  email: z.email().max(320).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
};
const submitSchema = z.object({
  zipPath: z.string().min(1).optional(),
  githubUrl: z.url().optional(),
  ref: z.string().min(1).max(250).optional(),
  excludePatterns: z.array(z.string().max(250)).max(100).optional(),
  ...common,
}).strict().refine((input) => Boolean(input.zipPath) !== Boolean(input.githubUrl), {
  message: 'zipPath 与 githubUrl 必须且只能提供一个',
}).refine((input) => !input.zipPath || !input.ref, { message: 'ZIP 不接受仓库 ref' });
const uploadSchema = z.object({ filePath: z.string().min(1), title: common.title.unwrap(), idempotencyKey: common.idempotencyKey }).strict();
const getSchema = z.object({ taskId: id }).strict();
const listSchema = z.object({}).strict();

const stringProperty = (description, extra = {}) => ({ type: 'string', description, ...extra });
export const TOOLS = [
  {
    name: 'cds_code_review_submit',
    title: '发起 CDS 代码审查',
    description: '在当前项目提交工作区内的 ZIP 或 GitHub 仓库地址。异步返回任务，所有报告归档 CDS；仅在提供 email 时额外发送邮件。上传源码不会执行项目脚本。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        zipPath: stringProperty('工作区内本地 ZIP 路径，不能指向服务器文件'),
        githubUrl: stringProperty('https://github.com/owner/repo 地址'),
        ref: stringProperty('仓库分支、标签或提交；ZIP 不使用此参数'),
        title: stringProperty('审查任务名称'),
        excludePatterns: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 250 } },
        email: stringProperty('可选报告收件邮箱，提供即授权本次任务发送邮件'),
        idempotencyKey: stringProperty('可选重试幂等键，相同提交重试时复用'),
      },
      oneOf: [{ required: ['zipPath'] }, { required: ['githubUrl'] }],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'cds_code_review_get', title: '查询代码审查任务',
    description: '查看当前项目的审查进度、失败原因、报告与邮件投递状态。',
    inputSchema: { type: 'object', properties: { taskId: stringProperty('任务 ID') }, required: ['taskId'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'cds_code_review_list', title: '列出代码审查任务',
    description: '只查询当前凭据绑定项目的审查任务和报告关联。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'cds_code_review_report_upload', title: '上传已有代码审查报告',
    description: '将工作区内已有的 HTML 或 Markdown 报告上传到当前项目的代码审查报告栏目，不重新执行审查，默认不公开分享。',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['filePath', 'title'],
      properties: {
        filePath: stringProperty('工作区内的 .html/.htm/.md/.markdown 文件路径'),
        title: stringProperty('报告标题'),
        idempotencyKey: stringProperty('可选上传幂等键'),
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

/** Mirrors cdscli's git-root discovery, including worktrees whose .git is a file. */
export async function workspaceRoot(start = process.cwd()) {
  const cwd = path.resolve(start);
  let candidate = cwd;
  while (true) {
    try { await fs.stat(path.join(candidate, '.git')); return candidate; } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('无法读取工作区 Git 标记');
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return cwd;
    candidate = parent;
  }
}

export async function readProjectCredentials(cwd = process.cwd()) {
  const root = await fs.realpath(await workspaceRoot(cwd));
  let raw;
  try { raw = JSON.parse(await fs.readFile(path.join(root, '.cds', 'credentials.json'), 'utf8')); }
  catch { throw new Error('无法读取当前项目 .cds/credentials.json，请先运行 cdscli connect'); }
  if (raw.version !== 1 || typeof raw.projectId !== 'string' || !raw.projectId.trim()
    || typeof raw.projectKey !== 'string' || !raw.projectKey.startsWith('cdsp_')
    || /[\r\n]/.test(raw.projectKey)) {
    throw new Error('需要版本 1 的项目级 CDS 凭据，请先运行 cdscli connect；不接受全局 bootstrap key');
  }
  let host;
  try {
    const value = typeof raw.host === 'string' ? raw.host.trim() : '';
    host = new URL(value.includes('://') ? value : `https://${value}`);
    if (host.username || host.password || host.search || host.hash || host.pathname !== '/') throw new Error();
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(host.hostname);
    if (host.protocol !== 'https:' && !(host.protocol === 'http:' && local)) throw new Error();
  } catch { throw new Error('CDS host 必须为 HTTPS 地址；仅本机回环地址允许 HTTP'); }
  return { root, host: host.origin, projectId: raw.projectId.trim(), projectKey: raw.projectKey };
}

async function localFile(credentials, filename, extensions, limit) {
  let resolved;
  try { resolved = await fs.realpath(path.resolve(credentials.root, filename)); }
  catch { throw new Error('本地上传文件不存在或不可读'); }
  const relative = path.relative(credentials.root, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)
    || relative.split(path.sep).some((part) => part === '.cds' || part === '.git')) {
    throw new Error('只能上传当前工作区内文件，不能穿越目录、上传凭据或通过软链接访问工作区外文件');
  }
  if (!extensions.includes(path.extname(resolved).toLowerCase())) throw new Error(`文件类型仅支持 ${extensions.join(', ')}`);
  let handle;
  try { handle = await fs.open(resolved, 'r'); }
  catch { throw new Error('本地上传文件不可读'); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > limit) throw new Error(`上传文件必须非空且不超过 ${limit / 1024 / 1024} MiB`);
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, null);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count > stat.size) throw new Error('上传文件在读取期间发生变化，请重试');
    return { bytes: bytes.subarray(0, count), name: path.basename(resolved) };
  } catch (error) {
    if (error.code) throw new Error('本地上传文件读取失败');
    throw error;
  } finally { await handle.close(); }
}

async function responseJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('CDS 响应超过允许大小');
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body ?? []) {
    length += chunk.length;
    if (length > MAX_RESPONSE_BYTES) throw new Error('CDS 响应超过允许大小');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error(`CDS 返回非 JSON 响应（HTTP ${response.status}）`); }
}

export function createBridge(credentials, { fetchImpl = fetch, dispatcher } = {}) {
  // Native fetch on Node 20 does not honor HTTP(S)_PROXY. Preserve configured
  // network routing and CA trust instead of silently attempting direct access.
  const ownedDispatcher = dispatcher ?? new EnvHttpProxyAgent();
  const assertProject = (resource) => {
    if (!resource || resource.projectId !== credentials.projectId) throw new Error('CDS 返回资源与当前项目不匹配');
  };
  async function request(method, endpoint, body) {
    const multipart = body instanceof FormData;
    let response;
    try {
      response = await fetchImpl(`${credentials.host}${endpoint}`, {
        method, redirect: 'error', dispatcher: ownedDispatcher,
        headers: {
          'Accept': 'application/json', 'User-Agent': 'curl/8.5.0 cds-code-review-mcp/1.0.0',
          'X-AI-Access-Key': credentials.projectKey, 'X-CDS-Agent': 'mcp',
          ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? (multipart ? body : JSON.stringify(body)) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch { throw new Error('CDS 请求失败或超时；请检查连接，不会跟随重定向发送凭据'); }
    const parsed = await responseJson(response);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('CDS 返回 JSON 对象格式错误');
    if (!response.ok) {
      // Upstream messages may echo SMTP passwords, model tokens or request data.
      // Keep the status actionable; detailed diagnostics stay in CDS's protected
      // audit log rather than being forwarded into the MCP conversation.
      const details = { 400: '参数不符合要求', 401: '项目凭据无效或已过期', 403: '当前项目无权访问此资源', 404: '任务或报告不存在', 409: '任务状态或幂等键冲突', 413: '上传超过大小限制', 429: '请求过于频繁', 502: '审查上游服务失败', 503: '审查或邮件服务未配置或不可用' };
      throw new Error(`CDS HTTP ${response.status}: ${details[response.status] ?? '请求失败，请查看 CDS 任务详情'}`);
    }
    return parsed;
  }
  return {
    async call(name, input = {}) {
      if (name === 'cds_code_review_submit') {
        const args = submitSchema.parse(input);
        let result;
        if (args.zipPath) {
          const file = await localFile(credentials, args.zipPath, ['.zip'], MAX_ZIP_BYTES);
          const form = new FormData();
          form.set('projectId', credentials.projectId);
          form.set('sourceType', 'zip');
          form.set('file', new Blob([file.bytes], { type: 'application/zip' }), file.name);
          for (const key of ['title', 'email', 'idempotencyKey']) if (args[key]) form.set(key, args[key]);
          if (args.excludePatterns) form.set('excludePatterns', JSON.stringify(args.excludePatterns));
          result = await request('POST', '/api/code-reviews', form);
        } else {
          const github = new URL(args.githubUrl);
          if (github.protocol !== 'https:' || github.hostname !== 'github.com' || github.port || github.username || github.password
            || github.search || github.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(github.pathname)) {
            throw new Error('请输入 https://github.com/owner/repo 仓库地址');
          }
          const { zipPath: ignored, ...rest } = args;
          result = await request('POST', '/api/code-reviews', { ...rest, projectId: credentials.projectId, sourceType: 'github' });
        }
        assertProject(result.task);
        return result;
      }
      if (name === 'cds_code_review_get') {
        const args = getSchema.parse(input);
        const result = await request('GET', `/api/code-reviews/${encodeURIComponent(args.taskId)}`);
        assertProject(result.task);
        return result;
      }
      if (name === 'cds_code_review_list') {
        listSchema.parse(input);
        const result = await request('GET', `/api/code-reviews?projectId=${encodeURIComponent(credentials.projectId)}`);
        if (!Array.isArray(result.tasks)) throw new Error('CDS 返回任务列表格式错误');
        result.tasks.forEach(assertProject);
        return result;
      }
      if (name === 'cds_code_review_report_upload') {
        const args = uploadSchema.parse(input);
        const file = await localFile(credentials, args.filePath, ['.html', '.htm', '.md', '.markdown'], MAX_REPORT_BYTES);
        const format = /\.(md|markdown)$/i.test(file.name) ? 'md' : 'html';
        const form = new FormData();
        form.set('projectId', credentials.projectId);
        form.set('title', args.title);
        form.set('format', format);
        form.set('file', new Blob([file.bytes], { type: format === 'md' ? 'text/markdown' : 'text/html' }), file.name);
        if (args.idempotencyKey) form.set('idempotencyKey', args.idempotencyKey);
        const result = await request('POST', '/api/code-reviews/reports', form);
        assertProject(result.report);
        return result;
      }
      throw new Error('未知 CDS 代码审查工具');
    },
    async close() { if (!dispatcher) await ownedDispatcher.close(); },
  };
}
