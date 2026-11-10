import { createHash } from 'node:crypto';
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import { buildZip } from '../utils/zip.js';
import { readReviewResponse, redactReviewEvidence, reviewJsonRequest, type CodeReviewAudit } from './code-review-audit.js';
import { redactBodyText } from './http-log-store.js';
import type { BranchEntry, Project } from '../types.js';

/** Only an explicitly owned root or this project's managed worktree may supply source. */
export function codeReviewRepositoryRoot(project: Pick<Project, 'id' | 'repoPath'>,
  branch: Pick<BranchEntry, 'projectId' | 'worktreePath'>, instanceRoot: string, instanceOwnerId?: string): string {
  if (branch.projectId !== project.id) throw new Error('所选分支不属于当前项目');
  const root = project.repoPath || (instanceOwnerId === project.id ? instanceRoot : branch.worktreePath);
  if (!root) throw new Error('项目仓库尚未同步就绪，请等待同步完成或改用 ZIP');
  return root;
}

export const CODE_REVIEW_ZIP_LIMITS = { compressed: 100 * 1024 * 1024, expanded: 1024 * 1024 * 1024,
  entries: 20_000, file: 200 * 1024 } as const;
const CODE_EXTENSIONS = new Set(['.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.go', '.rs', '.cpp', '.c', '.h',
  '.cc', '.hh', '.cs', '.php', '.rb', '.kt', '.swift', '.sql', '.sh', '.json', '.yml', '.yaml']);
const EXCLUDED_PARTS = new Set(['node_modules', '__pycache__', '.git', 'dist', 'build', 'vendor', 'thirdparty',
  'bin', 'obj', 'target', '.next', '.cds', '.ssh', '.aws', '.azure', '.kube']);
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function excludedByPattern(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const clean = pattern.trim().replace(/^\.\//, '').replace(/\/$/, '');
    if (!clean) return false;
    const regex = clean.split(/(\*\*|\*|\?)/).map((part) => part === '**' ? '.*' : part === '*' ? '[^/]*'
      : part === '?' ? '[^/]' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
    return new RegExp(`(?:^|/)${regex}(?:/|$)`).test(name);
  });
}

function safePath(name: string): boolean {
  return !!name && !name.includes('\\') && !name.includes('\0') && !name.startsWith('/')
    && !/^[a-zA-Z]:/.test(name) && !name.split('/').some((part) => part === '..' || part === '.');
}

export function shouldIncludeCodeReviewPath(name: string, patterns: string[] = []): boolean {
  const parts = name.split('/');
  const filename = parts.at(-1)!.toLowerCase();
  const extension = filename.slice(filename.lastIndexOf('.'));
  return !parts.some((part) => EXCLUDED_PARTS.has(part.toLowerCase()))
    && !filename.startsWith('.env') && !/\.(?:pem|key|p12|pfx)$/.test(filename)
    && CODE_EXTENSIONS.has(extension) && !filename.endsWith('.min.js')
    && !excludedByPattern(name, patterns);
}

/** Parse and verify every entry without extracting it to disk; forward only the sanitized archive. */
export async function validateCodeReviewZip(zip: Buffer, excludePatterns: string[] = [], normalizeWrapper = true): Promise<{
  zip: Buffer; totalFiles: number; skippedFiles: number;
}> {
  const result = await readCodeReviewSnapshot(zip, excludePatterns, normalizeWrapper);
  return { zip: result.zip, totalFiles: result.totalFiles, skippedFiles: result.skippedFiles };
}

/** Shared validation for the fixed static scanner; files have passed path, size and CRC checks. */
export async function readCodeReviewSnapshot(zip: Buffer, excludePatterns: string[] = [], normalizeWrapper = false): Promise<{
  zip: Buffer; totalFiles: number; skippedFiles: number; files: Array<{ name: string; data: Buffer }>;
}> {
  if (!Buffer.isBuffer(zip) || !zip.length || zip.length > CODE_REVIEW_ZIP_LIMITS.compressed) {
    throw new Error('ZIP 为空或超过 100 MiB');
  }
  if (excludePatterns.length > 100 || excludePatterns.some((p) => typeof p !== 'string' || p.length > 300)) {
    throw new Error('排除规则过多或过长');
  }
  const archive = await new Promise<ZipFile>((resolve, reject) => fromBuffer(zip,
    { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false },
    (error, file) => error || !file ? reject(error ?? new Error('ZIP 无效')) : resolve(file)));
  let expanded = 0;
  let entries = 0;
  let skippedFiles = 0;
  const selected: Array<{ name: string; data: Buffer }> = [];
  const seen = new Set<string>();
  try {
    await new Promise<void>((resolve, reject) => {
      let stopped = false;
      const fail = (error: unknown) => { if (!stopped) { stopped = true; archive.close(); reject(error); } };
      archive.on('error', fail);
      archive.on('end', () => { if (!stopped) { stopped = true; resolve(); } });
      archive.on('entry', (entry: Entry) => {
        void (async () => {
          if (++entries > CODE_REVIEW_ZIP_LIMITS.entries) throw new Error('ZIP 文件数量超过 20000');
          const mode = entry.externalFileAttributes >>> 16;
          const symlink = (mode & 0xf000) === 0xa000;
          if (!safePath(entry.fileName) || ![0, 0x8000, 0x4000, 0xa000].includes(mode & 0xf000) || entry.isEncrypted()) {
            throw new Error('ZIP 含不安全路径、特殊文件或加密文件');
          }
          if (seen.has(entry.fileName)) throw new Error('ZIP 含重复文件路径');
          seen.add(entry.fileName);
          expanded += entry.uncompressedSize;
          if (expanded > CODE_REVIEW_ZIP_LIMITS.expanded) throw new Error('ZIP 解压体积超过 1 GiB');
          const include = shouldIncludeCodeReviewPath(entry.fileName, excludePatterns) && entry.uncompressedSize <= CODE_REVIEW_ZIP_LIMITS.file;
          if (symlink && include) throw new Error('ZIP 审查范围内含符号链接');
          if (entry.fileName.endsWith('/') && !symlink) { archive.readEntry(); return; }
          if (!include) skippedFiles++;
          // Skipped links are verified as opaque bytes only: never resolve, follow, extract or forward them.
          // Verify all skipped entries too: lying sizes / corrupt data are never forwarded.
          const stream = await new Promise<NodeJS.ReadableStream>((res, rej) => archive.openReadStream(entry,
            (error, value) => error || !value ? rej(error ?? new Error('ZIP 无法读取')) : res(value)));
          const chunks: Buffer[] = [];
          let size = 0;
          let checksum = 0xffffffff;
          for await (const chunk of stream) {
            const data = Buffer.from(chunk);
            size += data.length;
            if (size > entry.uncompressedSize || size > CODE_REVIEW_ZIP_LIMITS.expanded) throw new Error('ZIP 实际解压体积超限');
            for (const byte of data) checksum = CRC_TABLE[(checksum ^ byte) & 255] ^ (checksum >>> 8);
            if (include) chunks.push(data);
          }
          if (size !== entry.uncompressedSize || ((checksum ^ 0xffffffff) >>> 0) !== entry.crc32) throw new Error('ZIP 内容校验失败');
          if (include) selected.push({ name: entry.fileName, data: Buffer.concat(chunks, size) });
          archive.readEntry();
        })().catch(fail);
      });
      archive.readEntry();
    });
  } finally { archive.close(); }
  if (!selected.length) throw new Error('没有可审查的源码文件；支持的源码单文件上限为 200 KiB');
  // GitHub archives and common uploaded ZIPs have a single wrapper directory.
  const firstParts = selected[0].name.split('/');
  const prefix = firstParts.length > 1 ? `${firstParts[0]}/` : '';
  const sourceRoots = new Set(['src', 'app', 'apps', 'lib', 'libs', 'test', 'tests', 'api', 'web', 'backend', 'frontend', 'packages']);
  // Filtering to one source subtree must not turn that real directory into a presumed archive wrapper.
  const stripPrefix = normalizeWrapper && prefix && !sourceRoots.has(firstParts[0]) && [...seen].every((name) => name.startsWith(prefix));
  const clean = selected.map((entry) => ({ ...entry, name: stripPrefix ? entry.name.slice(prefix.length) : entry.name,
    // Fixed local DOS timestamp makes snapshot hashes reproducible across retries and host timezones.
    modifiedAt: new Date(1980, 0, 1, 0, 0, 0) }));
  const sanitized = buildZip(clean);
  if (sanitized.length > CODE_REVIEW_ZIP_LIMITS.compressed) throw new Error('过滤后的源码 ZIP 超过 100 MiB');
  return { zip: sanitized, totalFiles: clean.length, skippedFiles, files: clean.map(({ name, data }) => ({ name, data })) };
}

export function parseCodeReviewGithubUrl(input: string): { owner: string; repo: string } {
  let parsed: URL;
  try { parsed = new URL(input); } catch { throw new Error('请输入 GitHub HTTPS 仓库地址'); }
  const parts = parsed.pathname.replace(/\/$/, '').split('/').filter(Boolean);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.port || parsed.username || parsed.password
    || parsed.search || parsed.hash || parts.length !== 2 || parts.some((p) => !/^[A-Za-z0-9_.-]+$/.test(p) || p === '.' || p === '..')) {
    throw new Error('仅支持 https://github.com/owner/repo 仓库地址；分支请填写在版本字段');
  }
  const repo = parts[1].replace(/\.git$/, '');
  if (!repo || repo === '.' || repo === '..') throw new Error('GitHub 仓库名称无效');
  return { owner: parts[0], repo };
}

async function snapshotFailureEvidence(response: Response, token?: string) {
  const limit = 8 * 1024, chunks: Buffer[] = [];
  let captured = 0, received = 0, incomplete = Number(response.headers.get('content-length')) > limit, bodyReadFailed = false;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (captured < limit) {
        const next = await reader.read();
        if (next.done) break;
        received += next.value.length;
        const part = Buffer.from(next.value.subarray(0, limit - captured));
        chunks.push(part); captured += part.length;
        if (captured === limit) incomplete = true;
      }
    } catch { incomplete = true; bodyReadFailed = true; }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  const bytes = Buffer.concat(chunks, captured);
  const scrub = (value: string) => {
    const redacted = redactReviewEvidence(redactBodyText(value));
    return token ? redacted.split(token).join('[credential]') : redacted;
  };
  const prefix = JSON.stringify({ capturedBytes: captured, receivedBytesLowerBound: received,
    capturedSHA256: createHash('sha256').update(bytes).digest('hex'), bodyReadFailed });
  const text = scrub(bytes.toString('utf8')), remaining = 4096 - prefix.length - 1;
  const requestId = response.headers.get('x-github-request-id') ?? response.headers.get('x-request-id');
  return { evidence: `${prefix}\n${text.slice(0, remaining)}`, truncated: incomplete || text.length > remaining,
    responseBytes: received, upstreamRequestId: requestId ? scrub(requestId).slice(0, 200) : undefined };
}

export async function fetchCodeReviewGithubSnapshot(input: {
  githubUrl: string; ref?: string; token?: string; signal: AbortSignal; audit: CodeReviewAudit; fetchImpl?: typeof fetch;
}): Promise<{ zip: Buffer; commitSha: string; sourceName: string }> {
  const { owner, repo } = parseCodeReviewGithubUrl(input.githubUrl);
  const sourceName = `${owner}/${repo}`;
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'CDS-Code-Review',
    'X-GitHub-Api-Version': '2022-11-28' };
  if (input.token) headers.Authorization = `Bearer ${input.token}`;
  const fetchImpl = input.fetchImpl ?? fetch;
  const details = await reviewJsonRequest('github.resolve_repository', base,
    { headers, signal: input.signal }, input.audit, fetchImpl) as { default_branch?: string };
  const ref = input.ref?.trim() || details.default_branch;
  if (!ref || ref.length > 250) throw new Error('GitHub 仓库没有可审查的版本');
  const commit = await reviewJsonRequest('github.resolve_commit', `${base}/commits/${encodeURIComponent(ref)}`,
    { headers, signal: input.signal }, input.audit, fetchImpl) as { sha?: string };
  if (!commit.sha || !/^[a-f0-9]{40}$/i.test(commit.sha)) throw new Error('GitHub 未返回有效的提交 SHA');
  let started = Date.now();
  let event = { operation: 'github.download_snapshot', url: `${base}/zipball/${commit.sha}`, method: 'GET',
    startedAt: new Date(started).toISOString() };
  let response: Response | undefined;
  let failureEvidenceAttempted = false;
  try {
    response = await fetchImpl(event.url, { headers, signal: input.signal, redirect: 'manual' });
    // GitHub redirects archives to codeload. Never forward installation credentials to another origin.
    if (response.status === 302 || response.status === 301 || response.status === 307) {
      const location = response.headers.get('location');
      await input.audit({ ...event, durationMs: Date.now() - started, status: response.status, outcome: 'success',
        evidence: JSON.stringify({ redirected: true, targetHost: location ? new URL(location).hostname : null }), truncated: false });
      if (!location) throw new Error('GitHub ZIP 重定向缺少目标');
      const target = new URL(location);
      if (target.protocol !== 'https:' || target.hostname !== 'codeload.github.com' || target.port || target.username || target.password) {
        throw new Error('GitHub ZIP 返回不允许的重定向地址');
      }
      await response.body?.cancel();
      started = Date.now();
      event = { ...event, url: target.origin + target.pathname, startedAt: new Date(started).toISOString() };
      response = undefined;
      response = await fetchImpl(target.href, { signal: input.signal, redirect: 'error',
        headers: { 'User-Agent': 'CDS-Code-Review' } });
    }
    if (!response.ok) {
      const evidence = await snapshotFailureEvidence(response, input.token);
      failureEvidenceAttempted = true;
      await input.audit({ ...event, durationMs: Date.now() - started, status: response.status, outcome: 'http_error', ...evidence });
      throw new Error(`GitHub 源码下载失败（HTTP ${response.status}）`);
    }
    const zip = await readReviewResponse(response, CODE_REVIEW_ZIP_LIMITS.compressed);
    await input.audit({ ...event, durationMs: Date.now() - started, status: response.status, outcome: 'success',
      evidence: JSON.stringify({ commitSha: commit.sha, bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex') }),
      responseBytes: zip.length, truncated: false });
    return { zip, commitSha: commit.sha, sourceName };
  } catch (error) {
    if (!failureEvidenceAttempted) await input.audit({ ...event, durationMs: Date.now() - started, status: response?.status,
      outcome: response ? 'http_error' : 'network_error', evidence: response ? '源码下载失败或重定向不符合限制' : '未收到响应', truncated: false });
    throw error;
  }
}
