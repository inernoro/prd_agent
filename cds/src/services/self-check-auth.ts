/*
 * 自检端点的鉴权：进程内一次性令牌 + 只认本机回环。
 *
 * 用户 2026-09-16：「免登录自检端点这个不行，泄漏数据，避免外部获取。」
 *
 * 自检文档只有聚合数字，但「部署失败率 29%」「磁盘 59%」「一条通知通道」这些
 * 对外就是情报。探测器与发现器跟端点在同一个进程里，所以鉴权不需要任何配置：
 * 进程起来时随机生成一段令牌，只留在内存里；打自检端点的请求必须带着它，
 * 并且必须来自本机回环。令牌不落盘、不进日志、不进 API，重启就换。
 *
 * 两条硬规矩：
 *   - 令牌**只发给自检端点自己的地址**（本机回环 + 自检路径），别的任何地址一律不带。
 *     探测器打的是用户配的外部地址，把内部令牌带出去等于泄漏。
 *   - 判定必须同时满足「回环 + 令牌相等」。nginx 反代的请求 remoteAddress 也是回环，
 *     所以回环单独不算数；令牌比较用常量时间。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { isSelfCheckEndpoint } from './self-monitoring-bootstrap.js';

export const SELF_CHECK_HEADER = 'x-cds-self-check';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  return Boolean(remoteAddress) && LOOPBACK.has(remoteAddress as string);
}

export interface SelfCheckAuth {
  /** 只对自检端点自己的地址返回令牌头；其它地址返回空对象。 */
  headersFor(url: string): Record<string, string>;
  /** 回环 + 令牌相等才放行。 */
  verify(input: { remoteAddress: string | undefined; header: string | undefined }): boolean;
}

export function createSelfCheckAuth(token: string = randomBytes(32).toString('hex')): SelfCheckAuth {
  const expected = Buffer.from(token, 'utf8');
  return {
    headersFor(url): Record<string, string> {
      if (!isSelfCheckEndpoint(url)) return {};
      return { [SELF_CHECK_HEADER]: token };
    },
    verify({ remoteAddress, header }) {
      if (!isLoopbackAddress(remoteAddress)) return false;
      if (typeof header !== 'string' || header.length === 0) return false;
      const given = Buffer.from(header, 'utf8');
      if (given.length !== expected.length) return false;
      return timingSafeEqual(given, expected);
    },
  };
}

/** 本进程唯一的一份。探测器、发现器、路由都用它，令牌不会有第二份。 */
export const selfCheckAuth: SelfCheckAuth = createSelfCheckAuth();

/** 给探测请求加的头：只有打自检端点自己时才非空。 */
export function internalProbeHeaders(url: string): Record<string, string> {
  return selfCheckAuth.headersFor(url);
}
