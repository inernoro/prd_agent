/**
 * 分支归属判定（本地 vs 远端 executor）的唯一判定源回归。
 *
 * 这条判定原本以内联字面量散在三处，存活监控新增第四个消费方时只照着
 * 「!== 'embedded'」写，把 master-* 的本地分支误判成远端、永久排除出监控。
 * 本套用例锁住口径，并守住「不许再出现内联副本」。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLocallyOwned, isRemoteExecutorOwned } from '../../src/services/executor-ownership.js';

describe('isRemoteExecutorOwned', () => {
  it('executorId 为空 = 本地', () => {
    expect(isRemoteExecutorOwned(undefined)).toBe(false);
    expect(isRemoteExecutorOwned(null)).toBe(false);
    expect(isRemoteExecutorOwned('')).toBe(false);
  });

  it('事故值：master-* 是内嵌 master 自己持有的本地分支，不是远端', () => {
    expect(isRemoteExecutorOwned('master-1')).toBe(false);
    expect(isRemoteExecutorOwned('master-abc123')).toBe(false);
    expect(isLocallyOwned('master-abc123')).toBe(true);
  });

  it('字面量 embedded 同样按本地处理（历史值）', () => {
    expect(isRemoteExecutorOwned('embedded')).toBe(false);
  });

  it('其余非空值 = 远端归属', () => {
    expect(isRemoteExecutorOwned('node-2')).toBe(true);
    expect(isRemoteExecutorOwned('worker-a')).toBe(true);
    expect(isLocallyOwned('node-2')).toBe(false);
  });
});

describe('判定不许再出现内联副本（防漂移）', () => {
  it("src 下除判定源自身外，不得再有 startsWith('master-') 的内联判定", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) { walk(full); continue; }
        if (!full.endsWith('.ts')) continue;
        if (full.endsWith('executor-ownership.ts')) continue;
        if (fs.readFileSync(full, 'utf-8').includes("startsWith('master-')")) hits.push(full);
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
