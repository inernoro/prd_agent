// 搬迁自 cds/src/services/agent-workspace-session-runtime.ts（第 1 阶段：只改归属、不改行为）。
// 第 4 阶段删除 CDS 旧实现之前，两边的判据必须保持逐字一致；改这里要同步改那边，反之亦然。
import crypto from 'node:crypto';
import path from 'node:path';

import { AgentWorkspaceRuntimeError } from '../errors.js';

export const SHA256_RE = /^[a-f0-9]{64}$/;

export function sha256(bytes: Uint8Array | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function normalizeRelativePath(value: unknown, label = 'file path'): string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value !== value.trim()
    || value.length > 512
    || value.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new AgentWorkspaceRuntimeError('workspace_package_invalid', `${label} must be a bounded POSIX relative path`);
  }
  const trimmed = value.trim();
  const normalized = path.posix.normalize(trimmed);
  if (
    path.posix.isAbsolute(trimmed)
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || normalized !== trimmed
    || trimmed.includes('\0')
  ) {
    throw new AgentWorkspaceRuntimeError('workspace_package_invalid', `${label} escapes the workspace: ${trimmed}`);
  }
  return normalized;
}

export function decodeBase64(value: unknown, filePath: string): Buffer {
  if (typeof value !== 'string') {
    throw new AgentWorkspaceRuntimeError('workspace_package_invalid', `invalid contentBase64 for ${filePath}`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw new AgentWorkspaceRuntimeError('workspace_package_invalid', `non-canonical contentBase64 for ${filePath}`);
  }
  return bytes;
}
