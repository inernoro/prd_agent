import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** 当前受保护提交是独立输入；工作目录、源码及依赖锁必须逐字等于该 Git 对象。 */
export async function qualifyNativeSource(root: string, expectedHead: string) {
  assert.match(expectedHead, /^[a-f0-9]{40}$/);
  const git = (args: string[], input?: string) => execFileSync('/usr/bin/git', args,
    { cwd: root, input, timeout: 30_000, maxBuffer: 128 * 1024 * 1024 });
  assert.equal(git(['rev-parse', 'HEAD']).toString().trim(), expectedHead, '原生候选提交与外部准确目标不符');
  assert.equal(git(['ls-files', '--others', '--exclude-standard', '--', 'cds/src', 'cds/scripts', 'cds/tests/helpers',
    'cds/package.json', 'cds/pnpm-lock.yaml']).toString().trim(), '', '原生候选含未提交输入');
  const entries = git(['ls-tree', '-rz', expectedHead, '--', 'cds/src', 'cds/scripts', 'cds/tests/helpers',
    'cds/package.json', 'cds/pnpm-lock.yaml']).toString().split('\0').filter(Boolean).map(line => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
    assert.ok(match, '原生输入必须是固定 Git 普通文件'); return { oid: match[2], name: match[3] };
  });
  assert.ok(entries.length > 0, '原生候选源清单为空');
  const bytes = git(['cat-file', '--batch'], entries.map(entry => entry.oid + '\n').join(''));
  let offset = 0; const hashes: Record<string, string> = {};
  for (const entry of entries) {
    const end = bytes.indexOf(10, offset); assert.ok(end >= offset);
    const header = /^([a-f0-9]{40}) blob (\d+)$/.exec(bytes.subarray(offset, end).toString());
    assert.ok(header); assert.equal(header[1], entry.oid);
    const length = Number(header[2]), original = bytes.subarray(end + 1, end + 1 + length);
    assert.equal(original.length, length); assert.equal((await fs.lstat(path.join(root, entry.name))).isFile(), true);
    assert.deepEqual(await fs.readFile(path.join(root, entry.name)), original,
      `原生实际源字节不符：${entry.name}`);
    hashes[entry.name] = createHash('sha256').update(original).digest('hex'); offset = end + length + 2;
  }
  assert.equal(offset, bytes.length);
  return { expectedHead, files: hashes, fileCount: entries.length };
}
