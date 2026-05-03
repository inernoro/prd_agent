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
    const worktreePath = WorktreeService.worktreePathFor(worktreeBase, projectId, branch);
    return this.writeFilesAtPath(worktreePath, files, { requireExist: true });
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

    // 校验 + 解析全部 payload。
    type Resolved = ProjectFilePayload & { absolutePath: string; bytes: number };
    const resolved: Resolved[] = [];
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

    const written: WrittenFile[] = [];
    for (const r of resolved) {
      const dir = path.dirname(r.absolutePath);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(r.absolutePath, r.content, 'utf-8');
      written.push({
        relativePath: r.relativePath,
        absolutePath: r.absolutePath,
        bytes: r.bytes,
      });
    }

    return { worktreePath: targetPath, written, totalBytes };
  }
}
