/**
 * Nginx Upstream Writer — 蓝绿切换写 nginx-active-upstream.conf 的封装(B'.4)
 *
 * 对应 spec.cds-blue-green-mece-acceptance.md 维度 4.3 / 4.5 / 5.4,以及
 * doc/design.cds-control-data-split.md 4.2 节"切流"步骤。
 *
 * Supervisor 在切换 admin daemon 颜色后,通过本模块:
 *   1. 备份当前 conf 到 .bak(回滚保险)
 *   2. 原子改写 cds-active-upstream.conf(tmp + rename)
 *   3. docker exec cds_nginx nginx -t 校验语法
 *   4. docker exec cds_nginx nginx -s reload 让新配置生效
 *   5.(可选)curl 探测目标 url 验证流量真到了新 upstream
 *
 * 任一阶段失败 → 把 .bak 原子 rename 回去,再 nginx -s reload 让旧配置重新生效。
 *
 * 设计要点:
 *   - shell 调用通过 IShellExecutor 注入,便于单测 mock
 *   - 路径白名单 + port 范围都过 helpers,杜绝注入
 *   - stage 字段标记失败阶段(backup/write/validate/reload/verify/done)
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { IShellExecutor } from '../types.js';
import {
  renderUpstream,
  validateConfPath,
  validatePort,
} from './nginx-upstream-writer.helpers.js';

export {
  validatePort,
  validateConfPath,
  renderUpstream,
} from './nginx-upstream-writer.helpers.js';

/** 容器名常量,后续如需可参数化。 */
export const NGINX_CONTAINER_NAME = 'cds_nginx';

export interface NginxValidationResult {
  ok: boolean;
  stderr: string;
}

export type SwapStage = 'backup' | 'write' | 'validate' | 'reload' | 'verify' | 'done';

export interface SwapOptions {
  /** 目标 conf 文件绝对路径(必须是 cds-active-upstream.conf)。 */
  absPath: string;
  /** 白名单目录,absPath 必须在该目录下。 */
  allowDir: string;
  /** 新的 upstream 端口(1024-65535)。 */
  port: number;
  /** Shell 执行器(单测注入 mock)。 */
  executor: IShellExecutor;
  /** 可选 verify 探测 URL(reload 后请求验证 200)。 */
  verifyTargetUrl?: string;
  /** verify 探测延迟(ms),默认 200ms。 */
  verifyDelayMs?: number;
}

export interface SwapResult {
  ok: boolean;
  stage: SwapStage;
  rolledBack: boolean;
  error?: string;
}

/**
 * 原子写文件:写到 tmp 路径再 rename 覆盖 target。失败时清理 tmp 残留,target 保持原状。
 *
 * fs.renameSync 在同文件系统下是原子的,reload 永远不会读到半截内容。
 */
export async function writeAtomic(
  absPath: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) {
    throw new Error(`writeAtomic: parent dir does not exist: ${dir}`);
  }
  const tmpPath = `${absPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf-8' });
    fs.renameSync(tmpPath, absPath);
  } catch (err) {
    // 清理 tmp 残留,target 保持原值
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // 清不掉就算了,主错误更重要
    }
    throw err;
  }
}

/**
 * docker cp <hostPath> cds_nginx:/etc/nginx/cds-active-upstream.conf
 *
 * 历史教训(2026-05-08 冒烟):docker compose volumes 增加 bind mount 必须重启
 * 容器才能生效,但重启 cds_nginx 会让所有业务流量瞬断 — 用户原则#3 禁止。
 *
 * 解法:supervisor 写完 host 文件后用 `docker cp` 直接把文件复制进运行中的
 * 容器,不需要 mount 也不需要重启。nginx -s reload 后能看到新内容。
 *
 * 注意路径校验:hostPath 必须在 allowDir 之下(已由 swap 入口校验);
 * 容器内目标路径写死 `/etc/nginx/cds-active-upstream.conf`,不接受外部输入。
 */
export async function copyConfIntoContainer(
  executor: IShellExecutor,
  hostPath: string,
): Promise<{ ok: boolean; stderr: string }> {
  const containerPath = '/etc/nginx/cds-active-upstream.conf';
  // hostPath 用单引号包裹,防 shell 注入(swap 已校验白名单,这里防御性补一道)
  const cmd = `docker cp ${shellEscape(hostPath)} ${NGINX_CONTAINER_NAME}:${containerPath}`;
  try {
    const r = await executor.exec(cmd, { timeout: 5000 });
    if (r.exitCode === 0) return { ok: true, stderr: r.stderr || '' };
    return { ok: false, stderr: `docker cp exit=${r.exitCode}: ${r.stderr || r.stdout}` };
  } catch (err) {
    return { ok: false, stderr: `docker cp threw: ${(err as Error).message}` };
  }
}

/** 简单 shell 转义:只允许 [a-zA-Z0-9/_.-],其它字符整个串单引号包起来。 */
function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9/_.\-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * docker exec cds_nginx nginx -t —— 校验配置文件语法。
 * nginx -t 即便成功也把消息打到 stderr,所以需要用 exitCode 判断,stderr 完整捕获。
 */
export async function validateNginxConf(
  executor: IShellExecutor,
): Promise<NginxValidationResult> {
  const cmd = `docker exec ${NGINX_CONTAINER_NAME} nginx -t`;
  const r = await executor.exec(cmd, { timeout: 15_000 });
  return {
    ok: r.exitCode === 0,
    stderr: r.stderr || r.stdout || '',
  };
}

/**
 * docker exec cds_nginx nginx -s reload —— 触发 graceful reload。
 */
export async function reloadNginx(
  executor: IShellExecutor,
): Promise<NginxValidationResult> {
  const cmd = `docker exec ${NGINX_CONTAINER_NAME} nginx -s reload`;
  const r = await executor.exec(cmd, { timeout: 15_000 });
  return {
    ok: r.exitCode === 0,
    stderr: r.stderr || r.stdout || '',
  };
}

/**
 * 内部:HTTP GET 探测,只判断 200(其他 status 视为失败)。
 * 单测里通过传 mock URL(127.0.0.1 + 临时 port)实测,生产环境跳过 verify。
 */
async function probeHttp(url: string, timeoutMs = 1000): Promise<{ ok: boolean; status?: number; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { ok: boolean; status?: number; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    try {
      const req = http.get(url, (res) => {
        // 排空 body 避免 socket 残留
        res.resume();
        const status = res.statusCode || 0;
        finish({ ok: status === 200, status });
      });
      req.on('error', (err) => finish({ ok: false, error: err.message }));
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('verify probe timeout'));
        finish({ ok: false, error: 'verify probe timeout' });
      });
    } catch (err) {
      finish({ ok: false, error: (err as Error).message });
    }
  });
}

/** sleep helper,Promise<void>。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把当前 conf 备份到 .bak(原子 cp via fs.copyFileSync)。
 * 当 absPath 不存在时跳过(首次写)。
 */
function backupCurrent(absPath: string): { existed: boolean; bakPath: string } {
  const bakPath = `${absPath}.bak`;
  if (!fs.existsSync(absPath)) {
    return { existed: false, bakPath };
  }
  fs.copyFileSync(absPath, bakPath);
  return { existed: true, bakPath };
}

/**
 * 把 .bak 还原回 absPath(原子 rename)。.bak 不存在时直接删 absPath
 * (恢复到"从未写过"的状态)。
 */
function restoreFromBak(absPath: string, bakPath: string): void {
  if (fs.existsSync(bakPath)) {
    // rename 是原子的;先写到一个 tmp 再 rename,避免 .bak 被消费掉
    const tmp = `${absPath}.restore.${process.pid}.${Date.now()}`;
    fs.copyFileSync(bakPath, tmp);
    fs.renameSync(tmp, absPath);
  } else if (fs.existsSync(absPath)) {
    fs.unlinkSync(absPath);
  }
}

/**
 * 清理同目录的 .tmp.* 残留(只清匹配的 absPath 前缀)。
 */
function cleanTmpResidue(absPath: string): void {
  try {
    const dir = path.dirname(absPath);
    const base = path.basename(absPath);
    const items = fs.readdirSync(dir);
    for (const item of items) {
      if (item.startsWith(`${base}.tmp.`) || item.startsWith(`${base}.restore.`)) {
        try {
          fs.unlinkSync(path.join(dir, item));
        } catch {
          // 清不掉的留着,下次再说
        }
      }
    }
  } catch {
    // 目录读不到就算了
  }
}

/**
 * 编排:备份 → 写 → 验证 → reload → 可选 verify。
 * 任一阶段失败 → 还原 .bak + 再 reload(让旧配置生效)。
 */
export async function swap(opts: SwapOptions): Promise<SwapResult> {
  // 0. 入参校验
  const portCheck = validatePort(opts.port);
  if (!portCheck.ok) {
    return { ok: false, stage: 'write', rolledBack: false, error: portCheck.reason };
  }
  const pathCheck = validateConfPath(opts.absPath, opts.allowDir);
  if (!pathCheck.ok) {
    return { ok: false, stage: 'write', rolledBack: false, error: pathCheck.reason };
  }

  const newContent = renderUpstream(opts.port);
  let bak: { existed: boolean; bakPath: string } | null = null;

  // 1. backup
  try {
    bak = backupCurrent(opts.absPath);
  } catch (err) {
    return {
      ok: false,
      stage: 'backup',
      rolledBack: false,
      error: `backup failed: ${(err as Error).message}`,
    };
  }

  // 2. write
  try {
    await writeAtomic(opts.absPath, newContent);
  } catch (err) {
    cleanTmpResidue(opts.absPath);
    return {
      ok: false,
      stage: 'write',
      rolledBack: false,
      error: `write failed: ${(err as Error).message}`,
    };
  }

  // 2.5. docker cp 把 host 文件注入到 cds_nginx 容器(防 mount 没生效场景)
  // 即使容器有 bind mount,这步是 idempotent 的(覆盖写)。
  const cp = await copyConfIntoContainer(opts.executor, opts.absPath);
  if (!cp.ok) {
    let rolledBack = false;
    try {
      restoreFromBak(opts.absPath, bak.bakPath);
      rolledBack = true;
    } catch { /* tolerate */ }
    cleanTmpResidue(opts.absPath);
    return {
      ok: false,
      stage: 'write',
      rolledBack,
      error: `docker cp failed: ${cp.stderr}`,
    };
  }

  // 3. validate (nginx -t)
  const v = await validateNginxConf(opts.executor);
  if (!v.ok) {
    // 回滚:把 .bak 还原回去(不再 reload,因为新配置没 load)
    let rolledBack = false;
    try {
      restoreFromBak(opts.absPath, bak.bakPath);
      rolledBack = true;
    } catch {
      rolledBack = false;
    }
    cleanTmpResidue(opts.absPath);
    return {
      ok: false,
      stage: 'validate',
      rolledBack,
      error: `nginx -t failed: ${v.stderr}`,
    };
  }

  // 4. reload
  const r = await reloadNginx(opts.executor);
  if (!r.ok) {
    let rolledBack = false;
    try {
      restoreFromBak(opts.absPath, bak.bakPath);
      // reload 失败必须再 reload 一次,让旧配置重新生效
      await reloadNginx(opts.executor);
      rolledBack = true;
    } catch {
      rolledBack = false;
    }
    cleanTmpResidue(opts.absPath);
    return {
      ok: false,
      stage: 'reload',
      rolledBack,
      error: `nginx -s reload failed: ${r.stderr}`,
    };
  }

  // 5. optional verify
  if (opts.verifyTargetUrl) {
    const delay = typeof opts.verifyDelayMs === 'number' ? opts.verifyDelayMs : 200;
    if (delay > 0) await sleep(delay);
    const probe = await probeHttp(opts.verifyTargetUrl, 1500);
    if (!probe.ok) {
      let rolledBack = false;
      try {
        restoreFromBak(opts.absPath, bak.bakPath);
        await reloadNginx(opts.executor);
        rolledBack = true;
      } catch {
        rolledBack = false;
      }
      cleanTmpResidue(opts.absPath);
      return {
        ok: false,
        stage: 'verify',
        rolledBack,
        error: `verify probe failed: ${probe.error || `status=${probe.status}`}`,
      };
    }
  }

  cleanTmpResidue(opts.absPath);
  return { ok: true, stage: 'done', rolledBack: false };
}

/**
 * 命名导出对象,便于 import { NginxUpstreamWriter } 后整体使用。
 */
export const NginxUpstreamWriter = {
  validatePort,
  validateConfPath,
  renderUpstream,
  writeAtomic,
  validateNginxConf,
  reloadNginx,
  swap,
};
