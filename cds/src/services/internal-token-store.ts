/**
 * Internal Token Store — daemon ↔ supervisor 之间共享的 secret(B'.5.1 hotfix)
 *
 * 背景:cds.miduo.org 冒烟发现 /api/_internal/promote 公网可调,根因是 nginx
 * 反代场景下 daemon 看到的 socket.remoteAddress 永远是 127.0.0.1(nginx 容器
 * 自己就是同主机回环来源),IP 校验完全失效。
 *
 * 修复模型:
 *   1. daemon 启动时生成 256-bit 随机 token,落盘到 .cds/internal-token(0600)
 *   2. supervisor 调 /api/_internal/* 前读 token 文件,加 X-CDS-Internal-Token header
 *   3. daemon middleware timing-safe 比对 header 与内存 token
 *   4. 攻击者拿不到文件(daemon 进程 owner 之外读不了)→ 无法伪造 header
 *
 * 配套:
 *   - nginx 顶层模板再加一条 `location /api/_internal/ { return 403; }` 兜底,
 *     让外部请求根本到不了 daemon(B'.8.2 nginx 模板修改)
 *   - IP 校验从 cds-internal.ts 移除(误导:nginx 反代下永远 pass,失去意义)
 *
 * 安全注意:
 *   - 文件 mode 0600 — 同主机其他用户读不了
 *   - 内存 compare 用 crypto.timingSafeEqual(避免 byte-by-byte 时序攻击)
 *   - token 不进任何 log / error message / response body
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export interface InternalTokenStore {
  /** 当前进程持有的 token,middleware 用它做 timing-safe 比对 */
  getToken(): string;
  /** 比对 header 携带的 token 是否匹配。timing-safe。 */
  verify(received: string | undefined): boolean;
  /** 把 token 持久化到磁盘(0600),supervisor 同主机调用时读这个文件 */
  persist(): void;
  /** 测试用:重置 token(在测试 setup 里 deterministic) */
  setForTest(value: string): void;
}

interface CreateOpts {
  tokenPath: string;     // 绝对路径,如 <cdsRoot>/.cds/internal-token
  /** 测试注入:跳过 fs 写入 */
  skipPersist?: boolean;
  /** 测试注入:固定 token(通常生产里不要传) */
  fixedToken?: string;
}

/** 创建一个进程级 token store。同一进程内只应该 new 一次,通过 ServerDeps 注入到路由层。 */
export function createInternalTokenStore(opts: CreateOpts): InternalTokenStore {
  // 启动时优先读取已存在的 token,让重启后 supervisor 不需要重新读文件;
  // 文件不存在 / 损坏 → 生成新的并落盘。
  let token = opts.fixedToken || tryReadExisting(opts.tokenPath) || randomBytes(32).toString('hex');

  function tryReadExisting(path: string): string | null {
    try {
      if (!existsSync(path)) return null;
      const v = readFileSync(path, 'utf8').trim();
      if (v.length >= 32) return v;
    } catch { /* tolerate */ }
    return null;
  }

  function persistImpl(): void {
    if (opts.skipPersist) return;
    const dir = dirname(opts.tokenPath);
    try { mkdirSync(dir, { recursive: true }); } catch { /* tolerate */ }
    writeFileSync(opts.tokenPath, token, { encoding: 'utf8', mode: 0o600 });
    // 防御:即使 mode 没生效(某些 fs 不支持),再 chmod 一次
    try { chmodSync(opts.tokenPath, 0o600); } catch { /* tolerate */ }
  }

  // 第一次启动 / 强制 fixed token 时落盘
  if (!opts.skipPersist) {
    try { persistImpl(); } catch { /* startup 容忍写失败,内存里仍有 token,只是 supervisor 同主机调用时读不到文件 */ }
  }

  return {
    getToken: () => token,
    verify: (received: string | undefined): boolean => {
      if (!received) return false;
      // 长度不一致 timingSafeEqual 会抛,先对齐再比对
      const a = Buffer.from(received, 'utf8');
      const b = Buffer.from(token, 'utf8');
      if (a.length !== b.length) {
        // 仍走 timingSafeEqual on padded buffer 防长度泄露
        const padded = Buffer.alloc(b.length);
        a.copy(padded, 0, 0, Math.min(a.length, padded.length));
        try { timingSafeEqual(padded, b); } catch { /* ignore */ }
        return false;
      }
      try { return timingSafeEqual(a, b); } catch { return false; }
    },
    persist: persistImpl,
    setForTest: (v: string) => { token = v; },
  };
}
