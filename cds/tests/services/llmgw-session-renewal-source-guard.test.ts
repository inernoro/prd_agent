/**
 * llmgw/web 会话滑动续期的源码守卫（2026-07-28）。
 *
 * 服务端用 X-Gw-Token 响应头换发新 token，前端必须在**每一条已鉴权请求**的响应里接住。
 * 走 `apiRequest` 的调用天然覆盖；问题出在绕开它的裸 fetch —— 漏掉一处，
 * 「只用那个功能」的用户就永远滑不动会话，会在最初的 7 天期限上掉登录
 * （真实案例：BugReportDialog 的提交请求）。
 *
 * llmgw/web 没有自己的测试工程，故把守卫挂在 cds 套件里（与
 * llmgw-bug-reports-source-guard.test.ts 同一惯例）。判定是纯文本的：
 * 带 Authorization 头的裸 fetch 所在文件必须出现 applyRenewedToken。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../llmgw/web/src');
/** 会话续期的 SSOT 自身，不参与「调用方必须调用它」的判定。 */
const API_CLIENT = path.join(WEB_SRC, 'lib/api.ts');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * 判定「用控制台会话发的裸 fetch」：既要有 Bearer 头，又要用 lib/api 的 getToken()。
 *
 * 排除掉用**服务密钥**打 serving 网关的调用（如 QuickstartPage 的 /gw/v1/* 试跑）：
 * 那条链路根本不是控制台会话，服务端也不会下发 X-Gw-Token，不该被这条守卫要求续期。
 */
function usesConsoleSessionRawFetch(source: string): boolean {
  return source.includes('fetch(')
    && /Authorization:\s*`Bearer/.test(source)
    && /getToken\s*[,}]/.test(source)
    && source.includes("from '@/lib/api'");
}

describe('llmgw/web 会话续期覆盖所有已鉴权请求', () => {
  const files = walk(WEB_SRC).filter((f) => path.resolve(f) !== path.resolve(API_CLIENT));

  it('扫得到前端源码', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('每个用会话 token 的裸 fetch 都接住了续期响应头', () => {
    const offenders = files.filter((file) => {
      const source = fs.readFileSync(file, 'utf-8');
      if (!usesConsoleSessionRawFetch(source)) return false;
      return !source.includes('applyRenewedToken');
    });

    expect(
      offenders.map((f) => path.relative(WEB_SRC, f)),
      '用会话 token 的裸 fetch 必须调用 applyRenewedToken(res, token)，否则该链路不续期',
    ).toEqual([]);
  });
});
