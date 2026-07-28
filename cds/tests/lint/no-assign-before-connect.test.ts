/**
 * 「先把 client 赋给实例、再 await connect()」在本仓库出现过 **5 次**，每次都是同一个
 * 后果，也每次都是被 Codex 一个一个揪出来的（PR #1275 一轮修了 state 的两个，
 * 七轮才轮到 auth 的第三个，随后自查又找出两个日志库）。这条 lint 把它一次钉死。
 *
 * 为什么危险：
 *   this.client = new MongoClient(...)   // ← 先挂上
 *   await this.client.connect();          // ← 这里抛
 * 失败之后 client 已经在实例上、db/collection 却是空的。而这些类的 connect/init
 * 开头统一是 `if (this.client) return;` —— 于是**后续每一次重试都被直接短路**，
 * 状态永远停在半开，取集合一律抛「not connected」。启动期退避重试因此完全空转；
 * 日志库则是静默死掉、再也不会自愈。
 *
 * 正确写法：局部变量 client，连成功（含建索引）才赋给 this，失败 close 后复位并抛出。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('禁止「先赋值再 connect」（同一个坑已出现 5 次）', () => {
  it('src/ 里不得再出现 this.<field> = new MongoClient(...)', () => {
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      const text = fs.readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/this\.\w+\s*=\s*new MongoClient\s*\(/.test(line)) {
          offenders.push(`${path.relative(srcRoot, file)}:${i + 1}`);
        }
      });
    }
    expect(
      offenders,
      '必须先用局部 client 连成功、再赋给实例；失败要 close 并复位，否则重试被 '
      + '`if (this.client) return` 永久短路。命中位置：\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('每个持有 MongoClient 的类，连接失败路径都会复位实例字段', () => {
    const files = walk(srcRoot).filter((f) => /new MongoClient\s*\(/.test(fs.readFileSync(f, 'utf8')));
    expect(files.length, '至少应有若干个持有 MongoClient 的模块').toBeGreaterThan(0);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const rel = path.relative(srcRoot, file);
      // 失败路径必须关掉半开连接：不 close 会泄漏 socket，也说明没走 try/catch
      expect(text, `${rel} 的连接失败路径应 close 掉半开连接`).toMatch(/\.close\(\)\.catch\(/);
    }
  });
});
