/**
 * cds/.cds.env 文件的原子 upsert/delete 工具。
 *
 * 复刻 exec_cds.sh 第 94 行起那段 awk 实现的 shell 逻辑：
 *   - upsert("KEY", "value") → 写入/覆盖 `export KEY="value"`
 *   - removeKey("KEY")       → 删除所有 `export KEY=` 行
 *
 * 用途：switch-to-mongo 端点成功时把 CDS_STORAGE_MODE / CDS_MONGO_URI /
 * CDS_MONGO_DB 固化到 .cds.env，让下次 CDS 重启时 exec_cds.sh source
 * 该文件 → process.env 自动含 Mongo URI → initStateService() 直接进
 * Mongo 分支，不再退回 JSON。
 *
 * 安全性：
 *   - 写入走 tmp 文件 + rename，避免半写状态
 *   - chmod 600（与 init 一致），防止 credentials 泄漏
 *   - 值里的 " 和 \ 会被转义，注入安全
 */
import fs from 'node:fs';
import path from 'node:path';

export interface EnvFileOps {
  upsert(key: string, value: string): void;
  removeKey(key: string): void;
  getPath(): string;
}

/**
 * Create an EnvFileOps bound to the given file path.
 * Callers typically pass `<repoRoot>/cds/.cds.env` or similar.
 */
export function createEnvFileOps(filePath: string): EnvFileOps {
  const absPath = path.resolve(filePath);

  function escapeForDoubleQuoted(v: string): string {
    // Bash double-quoted string only needs \ and " escaped; $ stays
    // special. Since we're persisting literal URIs not subject to
    // expansion, that's fine — but we also backslash-escape $ to be
    // safe against values that accidentally contain a dollar sign.
    return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
  }

  function readLines(): string[] {
    if (!fs.existsSync(absPath)) return [];
    return fs.readFileSync(absPath, 'utf-8').split('\n');
  }

  function writeAtomic(lines: string[]): void {
    const tmp = `${absPath}.tmp.${process.pid}`;
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
    fs.renameSync(tmp, absPath);
    try { fs.chmodSync(absPath, 0o600); } catch { /* best effort */ }
  }

  return {
    upsert(key, value) {
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
        throw new Error(`Invalid env key: ${key}`);
      }
      const lines = readLines();
      const prefix = `export ${key}=`;
      const kept = lines.filter((line) => !line.startsWith(prefix));
      kept.push(`${prefix}"${escapeForDoubleQuoted(value)}"`);
      // Strip trailing empty lines, add exactly one.
      while (kept.length > 1 && kept[kept.length - 1] === '') kept.pop();
      kept.push('');
      writeAtomic(kept);
    },
    removeKey(key) {
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
        throw new Error(`Invalid env key: ${key}`);
      }
      const lines = readLines();
      const prefix = `export ${key}=`;
      const kept = lines.filter((line) => !line.startsWith(prefix));
      while (kept.length > 1 && kept[kept.length - 1] === '') kept.pop();
      kept.push('');
      writeAtomic(kept);
    },
    getPath() { return absPath; },
  };
}
