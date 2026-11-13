import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CodeReviewFinding } from './code-review-engine.js';
import { readCodeReviewSnapshot } from './code-review-source.js';
import { CODE_REVIEW_SEMGREP_RULES } from './code-review-semgrep-rules.js';

interface SemgrepOutput {
  results?: Array<{ check_id?: string; path?: string; start?: { line?: number };
    extra?: { message?: string; severity?: string; metadata?: { category?: string } } }>;
  errors?: unknown[];
  paths?: { scanned?: unknown[]; skipped?: unknown[] };
}

const MAX_OUTPUT = 8 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

async function resolveExecutable(executable: string): Promise<string> {
  const candidates = executable.includes('/') || executable.includes('\\') ? [path.resolve(executable)]
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, executable));
  for (const candidate of candidates) {
    try { await fs.access(candidate, fsConstants.X_OK); return candidate; } catch { /* Try next PATH entry. */ }
  }
  throw Object.assign(new Error('Semgrep 未安装'), { code: 'ENOENT' });
}

function runFixedSemgrep(executable: string, args: string[], cwd: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // execFile does not forward spawn's detached option. setsid creates a Linux process group
    // so cancellation also terminates Semgrep's parser children, without invoking a shell.
    const grouped = process.platform === 'linux';
    const child = execFile(grouped ? 'setsid' : executable, grouped ? ['--wait', executable, ...args] : args, {
      cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT, windowsHide: true,
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: cwd, TMPDIR: cwd, XDG_CONFIG_HOME: cwd,
        SEMGREP_SETTINGS_FILE: path.join(cwd, 'settings.yml'), SEMGREP_SEND_METRICS: 'off',
        SEMGREP_ENABLE_VERSION_CHECK: '0', PYTHONNOUSERSITE: '1', NO_COLOR: '1' },
    }, (error, stdout) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      killGroup();
      if (signal.aborted) { reject(signal.reason); return; }
      if (timedOut) { reject(Object.assign(new Error('Semgrep 检查超时'), { code: 'TIMEOUT' })); return; }
      // Without --error, findings still exit zero. A nonzero result means checks did not complete.
      if (error) { reject(error); return; }
      resolve(stdout);
    });
    const killGroup = () => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { child.kill('SIGKILL'); }
    };
    const abort = () => killGroup();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, TIMEOUT_MS);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Genuine optional static checks; no project config, package script, shell, or downloaded rules run. */
export async function runCodeReviewStaticAnalysis(input: {
  zip: Buffer; signal: AbortSignal; executable?: string;
}): Promise<{ findings: CodeReviewFinding[]; notes: string[] }> {
  input.signal.throwIfAborted();
  const snapshot = await readCodeReviewSnapshot(input.zip);
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-static-review-'));
  try {
    await fs.chmod(base, 0o700);
    const sourceDir = path.join(base, 'source');
    await fs.mkdir(sourceDir, { mode: 0o700 });
    for (const file of snapshot.files) {
      input.signal.throwIfAborted();
      const target = path.resolve(sourceDir, file.name);
      if (!target.startsWith(sourceDir + path.sep)) throw new Error('静态检查文件路径超出隔离目录');
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, file.data, { mode: 0o600, flag: 'wx' });
    }
    const configPath = path.join(base, 'fixed-rules.yml');
    await fs.writeFile(configPath, CODE_REVIEW_SEMGREP_RULES, { mode: 0o600, flag: 'wx' });
    const executable = input.executable ?? process.env.CDS_CODE_REVIEW_SEMGREP_BIN ?? 'semgrep';
    let stdout: string;
    try {
      stdout = await runFixedSemgrep(await resolveExecutable(executable), [
        'scan', '--metrics=off', '--disable-version-check', '--json', '--config', configPath,
        '--jobs', '1', '--max-memory', '256', '--timeout', '10', '--timeout-threshold', '3',
        '--max-target-bytes', '204800', '--no-git-ignore', '--disable-nosem', '--no-rewrite-rule-ids', sourceDir,
      ], base, input.signal);
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason;
      const code = (error as NodeJS.ErrnoException)?.code;
      return { findings: [], notes: [code === 'ENOENT'
        ? '静态检查未运行：未安装 Semgrep；可通过 CDS_CODE_REVIEW_SEMGREP_BIN 配置管理员安装的可执行文件。'
        : code === 'TIMEOUT' ? '静态检查未完成：Semgrep 超过 60 秒执行预算，不能视为检查通过。'
          : '静态检查未完成：Semgrep 执行失败或输出超过 8 MiB 限额，不能视为检查通过。'] };
    }
    let parsed: SemgrepOutput;
    try { parsed = JSON.parse(stdout) as SemgrepOutput; } catch {
      return { findings: [], notes: ['静态检查未完成：Semgrep 返回了无法解析的结果，不能视为检查通过。'] };
    }
    if (!parsed || !Array.isArray(parsed.results)) {
      return { findings: [], notes: ['静态检查未完成：Semgrep 结果缺少问题列表，不能视为检查通过。'] };
    }
    const findings: CodeReviewFinding[] = [];
    let invalidPaths = 0;
    const allowedFiles = new Set(snapshot.files.map((file) => path.resolve(sourceDir, file.name)));
    for (const result of parsed.results) {
      if (!result.path || !result.check_id?.startsWith('cds.')) continue;
      let absolute = path.isAbsolute(result.path) ? path.resolve(result.path) : path.resolve(base, result.path);
      if (!allowedFiles.has(absolute)) absolute = path.resolve(sourceDir, result.path);
      if (!absolute.startsWith(sourceDir + path.sep) || !allowedFiles.has(absolute)) { invalidPaths++; continue; }
      const extra = result.extra ?? {};
      findings.push({ filePath: path.relative(sourceDir, absolute).split(path.sep).join('/'),
        line: Number.isInteger(result.start?.line) && Number(result.start?.line) > 0 ? result.start!.line : undefined,
        category: extra.metadata?.category === 'bug' ? 'bug' : 'security',
        severity: extra.severity === 'ERROR' ? 'high' : extra.severity === 'INFO' ? 'low' : 'medium',
        message: extra.message ?? `固定规则 ${result.check_id} 命中`, verified: false, tool: `Semgrep (${result.check_id})` });
    }
    const scanned = Array.isArray(parsed.paths?.scanned) ? parsed.paths.scanned.length : undefined;
    return { findings, notes: [
      `Semgrep 固定规则仅覆盖 JavaScript、TypeScript、Python 的部分安全与 Bug 模式，${scanned === undefined ? '未提供成功扫描文件数' : `成功扫描 ${scanned} 个文件`}；不能代表全部语言或全部缺陷类型。`,
      ...(parsed.errors?.length ? [`静态检查存在 ${parsed.errors.length} 项解析或执行错误，相关文件未完成检查。`] : []),
      ...(parsed.paths?.skipped?.length ? [`Semgrep 另有 ${parsed.paths.skipped.length} 个路径未检查。`] : []),
      ...(invalidPaths ? [`Semgrep 返回 ${invalidPaths} 项隔离目录外的路径，已拒绝纳入报告。`] : []),
    ] };
  } finally { await fs.rm(base, { recursive: true, force: true }); }
}
