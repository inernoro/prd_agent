// 产物出工作区之前的预检与导出。
//
// 搬迁自 cds/src/services/agent-workspace-session-runtime.ts 的 OUTPUT_PREFLIGHT_SCRIPT 与
// validateOutputsInContainer（第 1 阶段：只改归属、不改行为）。原来是在一个只读的一次性容器里跑这段
// 脚本、把白名单内的普通文件拷到宿主目录；现在同一段遍历直接在本进程里跑，失败原因不再经 stderr
// 字符串转一道，而是直接带着结构化的原因抛出——判据与错误码逐条不变：
// - 符号链接 / 特殊文件一律拒收；目录深度、节点数、工作区文件数、产物文件数、产物总字节都有上限；
// - 冻结的 MAP 输入逐字节比对，被改动或删除即拒收；
// - 白名单之外的路径（除运行时自己写的少数文件与 .od-skills/）一律拒收。
//
// 读文件用 O_NOFOLLOW 打开后再 fstat：遍历时判定为普通文件、读取前被换成符号链接的，读取会失败，
// 而不是顺着链接把工作区外的内容读出来（本服务与引擎同处一个容器，这一步比原来更要紧）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { IGNORED_RUNTIME_OUTPUT_PATHS, MAX_OUTPUT_FILE_COUNT } from '../artifact/public-package.js';
import { summarizeOutputPreflightDiagnostic } from '../diagnostics.js';
import { AgentWorkspaceRuntimeError } from '../errors.js';
import { normalizeRelativePath } from './primitives.js';

const MAX_WORKSPACE_FILE_COUNT = 1024;
const MAX_WORKSPACE_NODE_COUNT = 2048;
const MAX_WORKSPACE_DIRECTORY_DEPTH = 16;

type PreflightFailureCode =
  | 'node_count' | 'directory_depth' | 'special_file' | 'workspace_file_count' | 'file_count'
  | 'total_bytes' | 'path_not_allowed' | 'file_changed' | 'input_changed';

class PreflightFailure extends Error {
  constructor(readonly failureCode: PreflightFailureCode, readonly relativePath = '') {
    super(`output preflight failed: ${failureCode}`);
  }
}

export interface OutputPreflightInput {
  workspaceDir: string;
  outputDir: string;
  allowedOutputPaths: readonly string[];
  inputFiles: ReadonlyArray<{ path: string; sha256: string; size: number }>;
  maxOutputBytes: number;
}

/** 以不跟随符号链接的方式读一个普通文件；读到的不是普通文件就抛。 */
export function readRegularFileNoFollow(absolute: string, maxBytes?: number): Buffer {
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('not a regular file');
    if (maxBytes !== undefined && stat.size > maxBytes) throw new Error('file exceeds the read limit');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = fs.readSync(fd, bytes, offset, stat.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return offset === stat.size ? bytes : bytes.subarray(0, offset);
  } finally {
    fs.closeSync(fd);
  }
}

function runPreflight(input: OutputPreflightInput): void {
  const root = input.workspaceDir;
  const inputFiles = new Map(input.inputFiles.map((file) => [file.path, file]));
  const seenInputs = new Set<string>();
  const ignoredRuntimePaths = new Set<string>(IGNORED_RUNTIME_OUTPUT_PATHS);
  const allowed = (relative: string) => input.allowedOutputPaths.some((pattern) => {
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3);
      return relative === prefix || relative.startsWith(`${prefix}/`);
    }
    return relative === pattern;
  });
  let fileCount = 0;
  let totalBytes = 0;
  let workspaceFileCount = 0;
  let nodeCount = 0;
  const walk = (directory: string): void => {
    for (const name of fs.readdirSync(directory)) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      nodeCount += 1;
      if (nodeCount > MAX_WORKSPACE_NODE_COUNT) throw new PreflightFailure('node_count');
      if (relative.split('/').length > MAX_WORKSPACE_DIRECTORY_DEPTH) throw new PreflightFailure('directory_depth');
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new PreflightFailure('special_file', relative);
      if (stat.isDirectory()) { walk(absolute); continue; }
      workspaceFileCount += 1;
      if (workspaceFileCount > MAX_WORKSPACE_FILE_COUNT) throw new PreflightFailure('workspace_file_count');
      if (allowed(relative)) {
        fileCount += 1;
        totalBytes += stat.size;
        if (fileCount > MAX_OUTPUT_FILE_COUNT) throw new PreflightFailure('file_count');
        if (totalBytes > input.maxOutputBytes) throw new PreflightFailure('total_bytes');
        const target = path.join(input.outputDir, ...relative.split('/'));
        const targetRelative = path.relative(input.outputDir, target);
        if (targetRelative.startsWith('..') || path.isAbsolute(targetRelative)) throw new PreflightFailure('path_not_allowed', relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        let bytes: Buffer;
        try {
          bytes = readRegularFileNoFollow(absolute);
        } catch {
          throw new PreflightFailure('file_changed', relative);
        }
        if (bytes.length !== stat.size) throw new PreflightFailure('file_changed', relative);
        fs.writeFileSync(target, bytes, { flag: 'wx' });
        continue;
      }
      const frozen = inputFiles.get(relative);
      if (frozen) {
        let bytes: Buffer;
        try {
          bytes = readRegularFileNoFollow(absolute);
        } catch {
          throw new PreflightFailure('input_changed', relative);
        }
        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        if (bytes.length !== frozen.size || digest !== frozen.sha256) throw new PreflightFailure('input_changed', relative);
        seenInputs.add(relative);
        continue;
      }
      if (ignoredRuntimePaths.has(relative) || relative.startsWith('.od-skills/')) continue;
      throw new PreflightFailure('path_not_allowed', relative);
    }
  };
  walk(root);
  for (const inputPath of inputFiles.keys()) if (!seenInputs.has(inputPath)) throw new PreflightFailure('input_changed', inputPath);
}

function rejectedPath(relative: string): Record<string, unknown> {
  if (!relative) return { stage: 'output_preflight' };
  try {
    normalizeRelativePath(relative);
    return { stage: 'output_preflight', rejectedPath: relative.slice(0, 240) };
  } catch {
    return { stage: 'output_preflight' };
  }
}

/**
 * 校验工作区并把白名单内的产物导出到 outputDir。失败时抛出与原 CDS 实现同码同文案的错误。
 * 调用方负责在调用前后冻结 / 解冻引擎进程（对应原来的 docker pause / unpause）。
 */
export function exportValidatedOutputs(input: OutputPreflightInput): void {
  fs.rmSync(input.outputDir, { recursive: true, force: true });
  fs.mkdirSync(input.outputDir, { recursive: true, mode: 0o700 });
  try {
    runPreflight(input);
  } catch (error) {
    if (!(error instanceof PreflightFailure)) {
      // 兜底分支：上面每个已知原因都没命中（例如读目录时权限不足）。原来这里只剩一句
      // 「could not be validated」，真实原因谁也看不到；现在带一段有界摘要。
      throw new AgentWorkspaceRuntimeError(
        'workspace_output_validation_failed',
        `OpenDesign output could not be validated inside the managed workspace before transfer: ${summarizeOutputPreflightDiagnostic(error instanceof Error ? error.message : String(error))}`,
        true,
      );
    }
    switch (error.failureCode) {
      case 'total_bytes':
        throw new AgentWorkspaceRuntimeError('design_output_too_large', 'OpenDesign output exceeds maxOutputBytes');
      case 'file_count':
        throw new AgentWorkspaceRuntimeError(
          'design_output_too_many_files',
          `OpenDesign output exceeds the ${MAX_OUTPUT_FILE_COUNT}-file limit`,
        );
      case 'workspace_file_count':
      case 'node_count':
        throw new AgentWorkspaceRuntimeError(
          'design_output_too_many_files',
          'OpenDesign workspace exceeds the bounded file or node limit',
        );
      case 'directory_depth':
        throw new AgentWorkspaceRuntimeError(
          'design_output_invalid',
          `OpenDesign workspace exceeds the ${MAX_WORKSPACE_DIRECTORY_DEPTH}-level directory depth limit`,
        );
      case 'special_file':
        throw new AgentWorkspaceRuntimeError(
          'design_output_invalid',
          'OpenDesign output contains a special file or symbolic link',
          false,
          rejectedPath(error.relativePath),
        );
      case 'path_not_allowed':
        throw new AgentWorkspaceRuntimeError(
          'design_output_invalid',
          'OpenDesign output contains a path outside the transfer allowlist',
          false,
          rejectedPath(error.relativePath),
        );
      case 'input_changed':
        throw new AgentWorkspaceRuntimeError(
          'workspace_input_changed',
          'OpenDesign modified a frozen MAP input; the result was rejected',
        );
      case 'file_changed':
        throw new AgentWorkspaceRuntimeError(
          'design_output_invalid',
          'OpenDesign output changed while it was being exported',
        );
    }
  }
}
