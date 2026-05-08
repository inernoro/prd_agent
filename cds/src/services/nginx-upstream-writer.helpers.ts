/**
 * nginx-upstream-writer 的纯函数 helper(无副作用,易单测)
 *
 * 拆出来的目的:
 *   - port 校验、路径校验、模板生成都是纯输入→输出,不需要 mock
 *   - 主文件 nginx-upstream-writer.ts 专注 IO 编排(原子写、shell exec、回滚)
 */

import path from 'node:path';

export interface ValidationOk {
  readonly ok: true;
}

export interface ValidationErr {
  readonly ok: false;
  readonly reason: string;
}

export type ValidationResult = ValidationOk | ValidationErr;

/**
 * 校验端口号:必须是整数 1024-65535(避开特权端口)
 *
 * 拒绝场景(都属于"防注入" / 异常):
 *   - 非数字(string / NaN / Infinity)
 *   - 非整数(浮点)
 *   - <= 1023(特权端口,nginx 实际允许但 admin daemon 用不到,严格化)
 *   - > 65535(超过 TCP 端口上限)
 */
export function validatePort(port: unknown): ValidationResult {
  if (typeof port !== 'number') {
    return { ok: false, reason: `port must be a number, got ${typeof port}` };
  }
  if (!Number.isFinite(port)) {
    return { ok: false, reason: `port must be finite, got ${String(port)}` };
  }
  if (!Number.isInteger(port)) {
    return { ok: false, reason: `port must be an integer, got ${port}` };
  }
  if (port < 1024) {
    return { ok: false, reason: `port must be >= 1024, got ${port}` };
  }
  if (port > 65535) {
    return { ok: false, reason: `port must be <= 65535, got ${port}` };
  }
  return { ok: true };
}

/**
 * 校验目标 conf 文件路径是否符合白名单:
 *   - basename 必须等于 'cds-active-upstream.conf'
 *   - absPath 必须以 allowDir + path.sep 开头(防越界)
 *   - absPath 不允许包含 '..'(双重保险,即便已经 normalize)
 *   - absPath 必须是绝对路径
 *
 * 这条是 C-4.3 的硬契约,拒绝任何写到非白名单位置的尝试。
 */
export function validateConfPath(
  absPath: unknown,
  allowDir: unknown,
): ValidationResult {
  if (typeof absPath !== 'string' || absPath.length === 0) {
    return { ok: false, reason: 'absPath must be a non-empty string' };
  }
  if (typeof allowDir !== 'string' || allowDir.length === 0) {
    return { ok: false, reason: 'allowDir must be a non-empty string' };
  }
  // 注意:即便 path.normalize 会消除 '..',我们仍然显式检查原始字符串,
  // 以防上层把 '../etc/passwd' 直接传进来想绕开。
  if (absPath.includes('..')) {
    return { ok: false, reason: 'absPath must not contain ".."' };
  }
  if (!path.isAbsolute(absPath)) {
    return { ok: false, reason: 'absPath must be an absolute path' };
  }
  if (!path.isAbsolute(allowDir)) {
    return { ok: false, reason: 'allowDir must be an absolute path' };
  }
  const baseName = path.basename(absPath);
  if (baseName !== 'cds-active-upstream.conf') {
    return {
      ok: false,
      reason: `basename must be 'cds-active-upstream.conf', got '${baseName}'`,
    };
  }
  // 确保 absPath 严格在 allowDir 之下(以 sep 结尾的前缀匹配)
  const normalizedAllow = allowDir.endsWith(path.sep) ? allowDir : allowDir + path.sep;
  if (!absPath.startsWith(normalizedAllow)) {
    return {
      ok: false,
      reason: `absPath must reside under allowDir (allowDir=${allowDir})`,
    };
  }
  return { ok: true };
}

/**
 * 生成 cds_master upstream block。port 必须先过 validatePort(本函数会再校验一次,
 * 双保险,确保即便调用方忘了校验,这里也不会拼出非法内容)。
 *
 * 名字必须是 cds_master(2026-05-08 hotfix:之前我误用 cds_admin,但 cds 整个
 * codebase 一直叫 cds_master — exec_cds.sh nginx 模板里的 proxy_pass 用的也是
 * cds_master,nginx-render 输出的旧 inline 写法也是 upstream cds_master)。
 * 名字不匹配会导致 nginx -t "host not found in upstream cds_master" 失败,
 * 蓝绿 nginx-validate stage 全军覆没。冒烟实测发现的根因。
 *
 * 模板格式:
 *   upstream cds_master { server 127.0.0.1:<port>; keepalive 8; }
 */
export function renderUpstream(port: number): string {
  const v = validatePort(port);
  if (!v.ok) {
    throw new Error(`renderUpstream: ${v.reason}`);
  }
  return `upstream cds_master { server 127.0.0.1:${port}; keepalive 8; }\n`;
}
