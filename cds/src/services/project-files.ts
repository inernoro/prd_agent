/**
 * ProjectFilesService — write user-supplied files into a project's worktree.
 *
 * 用途(2026-05-03 收尾):
 *   - F12: 用户在 EnvSetupDialog 上传 init.sql,需要写到 mysql/postgres infra
 *          的 volume mount source 路径(默认 worktree 根目录)
 *   - F11(辅助): 沙盒项目首次 deploy 之前,写 cds-compose.yml + projectFiles
 *          到 worktree 默认分支(具体的 git init 由 routes/projects.ts 内联完成)
 *
 * 安全约束:
 *   - relativePath 必须是相对路径,不能含 `..`,不能 `/` 开头
 *   - 单文件 ≤ 256KB,单次 ≤ 1MB,最多 50 个
 *   - 写入前 normalize + 校验真实绝对路径仍在目标 worktree 内
 *     (防止 symlink / unicode normalization 绕过)
 *
 * 设计决策:
 *   - 不主动 git commit/push;CDS 只负责把文件落到 worktree,
 *     用户决定是否提交 git。文档里说明"上传的文件在 git pull 时若有
 *     未提交修改可能冲突"。
 *   - 走 fs.promises 而不是同步 IO,避免大文件 / 长任务下阻塞 event loop。
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { StateService } from './state.js';
import type { CdsConfig } from '../types.js';
import { WorktreeService } from './worktree.js';
import { isSafeGitRef } from './github-webhook-dispatcher.js';

export interface ProjectFilePayload {
  relativePath: string;
  content: string;
}

export interface WrittenFile {
  relativePath: string;
  absolutePath: string;
  bytes: number;
}

export interface WriteFilesResult {
  worktreePath: string;
  written: WrittenFile[];
  totalBytes: number;
}

/** 校验阶段的中间产物 — caller 一般不需要直接接触,作为 validatePayload 返回类型暴露。 */
export interface ResolvedFile {
  relativePath: string;
  content: string;
  absolutePath: string;
  bytes: number;
}

export class ProjectFileError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'ProjectFileError';
  }
}

/** 单文件最大字节数(256KB)— init.sql 通常 < 50KB,留足缓冲。 */
export const MAX_FILE_BYTES = 256 * 1024;
/** 单次请求总字节数(1MB)。 */
export const MAX_TOTAL_BYTES = 1 * 1024 * 1024;
/** 单次请求最多文件数。 */
export const MAX_FILES_PER_REQUEST = 50;

/** 允许的根目录相对路径深度,避免 a/b/c/d/e/... 无限嵌套构造攻击面。 */
const MAX_PATH_DEPTH = 10;

/** 允许的文件名 / 段字符:字母数字 + `_-.`。禁止空格 / 引号 / 通配符 / 控制符。 */
const PATH_SEGMENT_RE = /^[A-Za-z0-9_.\-]+$/;

/**
 * Codex P1 fix(2026-05-04 PR #523)— 防 symlink 跨界写入。
 *
 * lstat-walk 从 `realRoot`(已解析过的 canonical root,不含 symlink)
 * 到 `targetAbs`(将要 open 的文件绝对路径)之间的每段路径段。
 * 任意一段是 symbolic link → 抛 ProjectFileError(symlink_in_path)。
 *
 * 末段(将要新建/覆盖的文件本身)若不存在就跳过(ENOENT),因为新建文件
 * 不存在是合法状态;若存在但不是 symlink 也允许(覆盖语义)。
 *
 * 与写入步骤的 O_NOFOLLOW 配合:
 *   - lstat-walk 拦截 worktree 内已存在的 symlink ancestor
 *   - O_NOFOLLOW 拦截末端文件本身被 race 成 symlink
 *
 * **注意:本函数不创建任何目录**;调用方必须用 `safeEnsureDirChain`
 * 安全地分段 mkdir,而不是 fsp.mkdir(recursive: true) — 后者会跟随
 * symlink 在 worktree 外建空目录(Bugbot 第三轮发现的 P1)。
 */
async function assertNoSymlinkBetween(realRoot: string, targetAbs: string): Promise<void> {
  const rel = path.relative(realRoot, targetAbs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    // 不应该走到这 — validatePayload 已经 lexical 校验过。
    // 防御性二次拒绝。
    throw new ProjectFileError(
      400,
      'bad_path',
      `路径 ${targetAbs} 不在已解析的根 ${realRoot} 下`,
    );
  }
  const segments = rel.split(path.sep).filter((s) => s.length > 0);
  let cursor = realRoot;
  for (let i = 0; i < segments.length; i++) {
    cursor = path.join(cursor, segments[i]);
    let stat;
    try {
      stat = await fsp.lstat(cursor);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // 中间目录/末端文件还不存在 — 由后续 mkdir/open 创建,
        // 不可能已经是 symlink,后续段也无需检查。
        return;
      }
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new ProjectFileError(
        400,
        'symlink_in_path',
        `路径 '${rel}' 在段 '${segments[i]}' 处是 symbolic link;拒绝跟随符号链接写入`,
        'relativePath',
      );
    }
  }
}

/**
 * Bugbot fix(2026-05-04 PR #523 第三轮)— 安全分段 mkdir。
 *
 * 替代 `fsp.mkdir(targetDir, { recursive: true })`。recursive mkdir 会
 * 跟随 symlink — 如果 worktree 内有 `sym -> /outside`,上传到
 * `sym/subdir/file.sql` 会让 mkdir 在 `/outside/subdir/` 建空目录,
 * 即使后续 O_NOFOLLOW open 拦了文件本身,目录已经溢出 worktree。
 *
 * 安全分段 mkdir:
 *   - 从 realRoot 开始,逐段 lstat 检查
 *   - 已存在 + dir + 非 symlink → 继续走
 *   - 已存在 + symlink/non-dir → 拒绝
 *   - 不存在 → mkdir 单段(非 recursive,只创当前段),mkdir 不可能跟
 *     不存在的 symlink,所以新创目录天然安全
 *
 * 注意:本函数处理 *父目录链*,文件本身段 caller 单独 open()。
 *
 * 调用方式:`safeEnsureDirChain(realRoot, dirAbs)`,其中 dirAbs 是
 * 文件 absolute path 的 dirname。
 */
async function safeEnsureDirChain(realRoot: string, dirAbs: string): Promise<void> {
  const rel = path.relative(realRoot, dirAbs);
  if (rel === '') return; // dirAbs === realRoot,无需 mkdir
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ProjectFileError(
      400,
      'bad_path',
      `目录 ${dirAbs} 不在已解析的根 ${realRoot} 下`,
    );
  }
  const segments = rel.split(path.sep).filter((s) => s.length > 0);
  let cursor = realRoot;
  for (let i = 0; i < segments.length; i++) {
    cursor = path.join(cursor, segments[i]);
    let stat;
    try {
      stat = await fsp.lstat(cursor);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
      // 不存在 — 单段 mkdir(非 recursive)。如果同名 symlink race-create,
      // 下一轮 lstat 会抛(EEXIST 不在这里 catch,EEXIST 由 mkdir 抛)。
      try {
        await fsp.mkdir(cursor);
      } catch (mkErr) {
        const mkCode = (mkErr as NodeJS.ErrnoException).code;
        if (mkCode === 'EEXIST') {
          // race:别人刚 create 了同名实体,继续走 lstat 确认不是 symlink
          stat = await fsp.lstat(cursor);
        } else {
          throw mkErr;
        }
      }
      // mkdir 成功 → 新目录,确定不是 symlink,跳过下面的 lstat 检查
      if (!stat) continue;
    }
    if (stat.isSymbolicLink()) {
      throw new ProjectFileError(
        400,
        'symlink_in_path',
        `目录链 '${rel}' 在段 '${segments[i]}' 处是 symbolic link;拒绝跟随符号链接 mkdir`,
        'relativePath',
      );
    }
    if (!stat.isDirectory()) {
      throw new ProjectFileError(
        400,
        'not_directory',
        `路径段 '${segments[i]}' 已存在但不是目录(可能是文件或其它实体)`,
        'relativePath',
      );
    }
  }
}

export class ProjectFilesService {
  constructor(
    private readonly stateService: StateService,
    private readonly config: CdsConfig | undefined,
  ) {}

  /**
   * 校验并写入一组文件到指定项目的指定分支 worktree。
   *
   * 条件:worktree 目录必须已存在(分支已 clone / 已创建)。
   * 校验全部通过才开始写;任一条失败抛 ProjectFileError 全部不写。
   * 父目录不存在自动 mkdir -p。已存在的同名文件直接覆盖(语义即"上传 = 覆盖")。
   *
   * @returns 实际写入的文件列表 + worktree 绝对路径(便于审计/UI 回显)。
   */
  async writeFiles(
    projectId: string,
    branchSlug: string,
    files: ProjectFilePayload[],
  ): Promise<WriteFilesResult> {
    const project = this.stateService.getProject(projectId);
    if (!project) {
      throw new ProjectFileError(404, 'project_not_found', `项目 ${projectId} 不存在`);
    }

    if (!Array.isArray(files) || files.length === 0) {
      throw new ProjectFileError(400, 'no_files', 'files 数组不能为空', 'files');
    }
    if (files.length > MAX_FILES_PER_REQUEST) {
      throw new ProjectFileError(
        400,
        'too_many_files',
        `单次最多 ${MAX_FILES_PER_REQUEST} 个文件`,
        'files',
      );
    }

    const worktreeBase = this.config?.worktreeBase || this.config?.reposBase;
    if (!worktreeBase) {
      throw new ProjectFileError(
        500,
        'worktree_base_missing',
        'CDS 未配置 worktreeBase / reposBase,无法定位写入目标目录(检查 .cds.env)',
      );
    }

    const branch = (branchSlug || '').trim();
    if (!branch) {
      throw new ProjectFileError(400, 'branch_required', 'branch 不能为空', 'branch');
    }
    // Codex P1 fix(2026-05-04 PR #523):防止 branch slug 路径穿越。
    // 之前只校验非空就拼接 worktreePath = base/projectId/branch,attacker
    // 传 branch="../../etc" 经 path.posix.join 后跳出 worktreeBase。
    // isSafeGitRef 已在 webhook 路径用,要求 git ref 安全字符且禁 ".."。
    if (!isSafeGitRef(branch)) {
      throw new ProjectFileError(
        400,
        'bad_branch',
        `branch 含非法字符或路径穿越尝试: ${branch.slice(0, 80)}`,
        'branch',
      );
    }
    const worktreePath = WorktreeService.worktreePathFor(worktreeBase, projectId, branch);
    return this.writeFilesAtPath(worktreePath, files, { requireExist: true });
  }

  /**
   * 纯校验 — 不碰文件系统,失败抛 ProjectFileError。返回 resolved 列表
   * 给 caller 复用(避免重复跑路径解析)。
   *
   * Bugbot fix(2026-05-04 PR #523):F11 沙盒模式 `initSandboxRepo` 之前
   * 先 mkdir + git init 才调 writeFilesAtPath 校验,任何路径/大小问题
   * 都会留下半成品空目录。把校验抽出来供 caller 在 mkdir 之前先跑一遍。
   */
  validatePayload(targetPath: string, files: ProjectFilePayload[]): ResolvedFile[] {
    if (!Array.isArray(files) || files.length === 0) {
      throw new ProjectFileError(400, 'no_files', 'files 数组不能为空', 'files');
    }
    if (files.length > MAX_FILES_PER_REQUEST) {
      throw new ProjectFileError(
        400,
        'too_many_files',
        `单次最多 ${MAX_FILES_PER_REQUEST} 个文件`,
        'files',
      );
    }
    const targetReal = path.resolve(targetPath);
    const resolved: ResolvedFile[] = [];
    let totalBytes = 0;
    const seen = new Set<string>();
    for (const raw of files) {
      const relRaw = (raw && typeof raw.relativePath === 'string') ? raw.relativePath : '';
      const content = (raw && typeof raw.content === 'string') ? raw.content : '';
      const rel = relRaw.replace(/^\.\//, '').trim();
      if (!rel) {
        throw new ProjectFileError(400, 'bad_path', '存在空 relativePath', 'relativePath');
      }
      if (rel.startsWith('/') || rel.includes('\\')) {
        throw new ProjectFileError(400, 'bad_path', `非法路径 ${rel}`, 'relativePath');
      }
      const segments = rel.split('/');
      if (segments.length > MAX_PATH_DEPTH) {
        throw new ProjectFileError(400, 'bad_path', `路径深度超过 ${MAX_PATH_DEPTH}`, 'relativePath');
      }
      for (const seg of segments) {
        if (!seg || seg === '.' || seg === '..') {
          throw new ProjectFileError(400, 'bad_path', `非法路径段 '${seg}'`, 'relativePath');
        }
        if (!PATH_SEGMENT_RE.test(seg)) {
          throw new ProjectFileError(
            400,
            'bad_path',
            `路径段 '${seg}' 含非法字符(只允许 A-Za-z0-9_-.)`,
            'relativePath',
          );
        }
      }
      const abs = path.resolve(targetPath, rel);
      const relCheck = path.relative(targetReal, abs);
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        throw new ProjectFileError(400, 'bad_path', `路径 '${rel}' 解析后逃出目标目录`, 'relativePath');
      }
      const bytes = Buffer.byteLength(content, 'utf-8');
      if (bytes > MAX_FILE_BYTES) {
        throw new ProjectFileError(
          413,
          'file_too_large',
          `${rel} 大小 ${bytes} 字节,超过单文件上限 ${MAX_FILE_BYTES}`,
          'content',
        );
      }
      totalBytes += bytes;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new ProjectFileError(
          413,
          'request_too_large',
          `本次写入总字节 ${totalBytes} 超过 ${MAX_TOTAL_BYTES}`,
          'files',
        );
      }
      if (seen.has(rel)) {
        throw new ProjectFileError(409, 'duplicate_path', `${rel} 在同次请求中出现两次`, 'relativePath');
      }
      seen.add(rel);
      resolved.push({ relativePath: rel, content, absolutePath: abs, bytes });
    }
    return resolved;
  }

  /**
   * F11 沙盒项目用:给一个明确的 absolute target path 写文件。
   * 比 writeFiles 灵活 — caller 已知绝对路径(比如 repoPath 而不是 worktree)
   * 不通过 worktreeBase + projectId + branch 推导。
   *
   * 校验同 writeFiles。requireExist=false 时若 targetPath 不存在会自动 mkdir。
   */
  async writeFilesAtPath(
    targetPath: string,
    files: ProjectFilePayload[],
    opts: { requireExist?: boolean } = {},
  ): Promise<WriteFilesResult> {
    const requireExist = opts.requireExist ?? true;
    const resolved = this.validatePayload(targetPath, files);
    const totalBytes = resolved.reduce((s, r) => s + r.bytes, 0);

    if (requireExist && !fs.existsSync(targetPath)) {
      throw new ProjectFileError(
        409,
        'target_missing',
        `目标目录不存在 (${targetPath});分支 worktree 可能尚未 clone / create`,
      );
    }
    if (!fs.existsSync(targetPath)) {
      await fsp.mkdir(targetPath, { recursive: true });
    }

    // Codex P1 fix(2026-05-04 PR #523):resolve symlinks on the canonical
    // root once,后续按 real-root 做 lstat-walk 阻止跟随 symlink。
    // 之前 path.resolve 是纯 lexical,worktree 内有指向外部的 symlink
    // (如 untrusted repo 自带的 link)时,attacker 可以上传到
    // `symlink_dir/file.sql` 让 fs.writeFile 跟随 symlink 写到外部。
    //
    // 注意:macOS 下 /var → /private/var 是 OS 级 symlink,realpath 会
    // canonicalize 到 /private/var。所以下面所有 absolutePath 都要基于
    // realTargetPath 重算,不能用 validatePayload 阶段算的(基于原始
    // targetPath,会和 realTargetPath 漂移导致 path.relative 算出 `..`)。
    const realTargetPath = await fsp.realpath(targetPath);

    const written: WrittenFile[] = [];
    for (const r of resolved) {
      // 基于 real-root 重新计算绝对路径(覆盖 validatePayload 阶段的 lexical 值)
      const realAbsPath = path.resolve(realTargetPath, r.relativePath);
      const dir = path.dirname(realAbsPath);
      // Bugbot 第三轮 fix(2026-05-04):用 safeEnsureDirChain 替代
      // fsp.mkdir(recursive: true)。recursive mkdir 会跟随 symlink 在
      // 外部目录建空文件夹(side effect 跑出 boundary,即使 O_NOFOLLOW
      // 拦了文件本身)。safeEnsureDirChain 分段 lstat + 单段 mkdir,
      // 任何中间 ancestor 是 symlink → 抛 symlink_in_path。
      await safeEnsureDirChain(realTargetPath, dir);
      // 末段(文件本身)的 lstat-walk:防御性 — 文件可能已存在为 symlink。
      await assertNoSymlinkBetween(realTargetPath, realAbsPath);
      // O_NOFOLLOW 双保险:即使 lstat 之后 attacker race-create 了
      // symlink,O_NOFOLLOW 让 open() 直接返回 ELOOP 而不跟随。
      const fd = await fsp.open(
        realAbsPath,
        // 覆盖语义(EnvSetupDialog 上传 init.sql 二次时):W + CREAT + TRUNC
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
        0o644,
      );
      try {
        await fd.writeFile(r.content, 'utf-8');
      } finally {
        await fd.close();
      }
      written.push({
        relativePath: r.relativePath,
        absolutePath: realAbsPath,
        bytes: r.bytes,
      });
    }

    return { worktreePath: targetPath, written, totalBytes };
  }
}
