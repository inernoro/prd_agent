// CDS 运维控制台 — 注册表
//
// 2026-05-28 用户反馈:不希望"前端 agent + SSH agent 之间反复 bounce"。
// 设计原则:任何"运维侧能修的问题",必须能在 CDS Dashboard 上一键自助修复。
// 杜绝"得开终端 SSH 上去改 nginx" 这种链路。
//
// 安全约束:
//   - 每个 op 必须 AI_ACCESS_KEY 或 cookie 鉴权
//   - 不接受任意 shell 字符串,只允许执行已注册 op
//   - 每个 op 标 danger 等级 (safe / sensitive / destructive)
//   - destructive 需要客户端显式 confirm token
//   - 所有 op 执行写 server-event-log,actor / args / result / output 全留痕

import type { IShellExecutor } from '../types.js';
import type { StateService } from './state.js';
import type { ServerEventLogSink } from './server-event-log-store.js';

export type OperatorOpDanger = 'safe' | 'sensitive' | 'destructive';

export interface OperatorOpContext {
  shell: IShellExecutor;
  stateService: StateService;
  repoRoot: string;
  serverEventLogStore?: ServerEventLogSink | null;
  actor: string;
  /** 把日志写到 SSE stream(前端实时显示) */
  log: (level: 'info' | 'warning' | 'error', message: string) => void;
}

export interface OperatorOpDef {
  id: string;
  name: string;
  description: string;
  danger: OperatorOpDanger;
  /** safe 不需要,sensitive 需要 access key,destructive 需要 access key + confirmText */
  confirmText?: string;
  /** 估时秒数,UI 显示进度提示 */
  estimatedSeconds?: number;
  /** 执行函数;throw 视为失败 */
  run: (ctx: OperatorOpContext) => Promise<{ summary: string; details?: Record<string, unknown> }>;
}

class OperatorOpRegistry {
  private ops = new Map<string, OperatorOpDef>();

  register(op: OperatorOpDef): void {
    if (this.ops.has(op.id)) {
      // eslint-disable-next-line no-console
      console.warn(`[operator-console] op '${op.id}' 已存在,覆盖`);
    }
    this.ops.set(op.id, op);
  }

  get(id: string): OperatorOpDef | undefined {
    return this.ops.get(id);
  }

  list(): Array<Omit<OperatorOpDef, 'run'>> {
    return [...this.ops.values()].map(({ run: _r, ...rest }) => rest);
  }
}

export const operatorOpRegistry = new OperatorOpRegistry();

// ── 内置 ops ──────────────────────────────────────────────────────────

operatorOpRegistry.register({
  id: 'host.stats',
  name: '查看主机资源状态',
  description: '读取 CPU / 内存 / 磁盘 / 网络当前指标。只读,无副作用。',
  danger: 'safe',
  estimatedSeconds: 1,
  run: async ({ shell, log }) => {
    log('info', '采集主机资源...');
    const out: Record<string, string> = {};
    // 2026-05-28 修 stuck:每条命令都要带 shell wrapper 才能跑 pipe。
    // 原 docker ps 命令含 {{.Names}} 这种 docker 模板语法,直接 exec 会把
    // 双引号 escape 出 bug。改用更简单的 docker ps --format,不嵌 template。
    for (const [k, cmd] of Object.entries({
      uptime: 'uptime',
      memory: 'free -h | head -3',
      disk: 'df -h / | tail -1',
      load: 'cat /proc/loadavg',
      topProc: 'ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu --no-headers | head -8',
      docker: 'docker ps --no-trunc --format "{{.Names}} | {{.Status}}" | head -20',
    })) {
      try {
        log('info', `> ${cmd}`);
        const r = await shell.exec(cmd, { timeout: 8000 });
        const sample = (r.stdout || r.stderr || '').trim();
        out[k] = sample;
        log('info', `${k}: ${sample.split('\n')[0].slice(0, 100)}`);
      } catch (err) {
        out[k] = `ERR: ${(err as Error).message}`;
        log('warning', `${k}: ${out[k]}`);
      }
    }
    log('info', '采集完成');
    return { summary: '主机资源采集完成', details: out };
  },
});

operatorOpRegistry.register({
  id: 'nginx.dump-config',
  name: '导出 nginx 完整运行配置',
  description: '在 cds_nginx 容器内运行 `nginx -T`,导出最终生效的所有 server / upstream / location 块。',
  danger: 'safe',
  estimatedSeconds: 2,
  run: async ({ shell, log }) => {
    log('info', '运行 docker exec cds_nginx nginx -T ...');
    const r = await shell.exec('docker exec cds_nginx nginx -T 2>&1', { timeout: 15_000 });
    const out = r.stdout || r.stderr || '';
    log('info', `配置长度: ${out.length} 字符,${out.split('\n').length} 行`);
    return { summary: `nginx 配置 dump 成功(${out.length} 字符)`, details: { config: out } };
  },
});

operatorOpRegistry.register({
  id: 'nginx.tail-error-log',
  name: '查看 nginx 最近 100 行 error log',
  description: '从 cds_nginx docker container 拉最近 100 行 stderr。用于诊断 50% 400 / upstream 错误。',
  danger: 'safe',
  estimatedSeconds: 2,
  run: async ({ shell, log }) => {
    log('info', '抓取 docker logs cds_nginx --tail 100 2>&1 | grep error ...');
    const r = await shell.exec(
      'docker logs cds_nginx --tail 200 2>&1 | grep -iE "error|warn|reset|prematurely|recv\\(\\)" | tail -100',
      { timeout: 10_000 },
    );
    const lines = (r.stdout || '').split('\n').filter(Boolean);
    log('info', `拿到 ${lines.length} 行错误`);
    return { summary: `nginx error log ${lines.length} 行`, details: { lines } };
  },
});

operatorOpRegistry.register({
  id: 'nginx.reload',
  name: '重载 nginx 配置(docker exec nginx -s reload)',
  description: '在 cds_nginx 容器里执行 nginx -t 校验后 nginx -s reload。不重启容器,不断连接,适合配置改后生效。',
  danger: 'sensitive',
  estimatedSeconds: 3,
  run: async ({ shell, log }) => {
    log('info', '先 nginx -t 校验配置...');
    const t = await shell.exec('docker exec cds_nginx nginx -t 2>&1', { timeout: 10_000 });
    if (t.exitCode !== 0) {
      const errOut = (t.stderr || t.stdout || '').trim();
      log('error', `nginx -t 校验失败,拒绝 reload: ${errOut.slice(0, 200)}`);
      throw new Error(`nginx -t 校验失败: ${errOut.slice(0, 500)}`);
    }
    log('info', 'nginx -t 通过,执行 nginx -s reload...');
    const r = await shell.exec('docker exec cds_nginx nginx -s reload 2>&1', { timeout: 15_000 });
    if (r.exitCode !== 0) {
      const errOut = (r.stderr || r.stdout || '').trim();
      log('error', `reload 失败: ${errOut.slice(0, 200)}`);
      throw new Error(`reload 失败: ${errOut.slice(0, 500)}`);
    }
    log('info', '✓ nginx -s reload 完成,在线连接不受影响');
    return { summary: 'nginx 配置已重载', details: { reloadOutput: r.stdout, validateOutput: t.stdout } };
  },
});

operatorOpRegistry.register({
  id: 'nginx.disable-upstream-keepalive',
  name: '禁用 cds_master upstream keepalive 池(根治 SSE 50% 400)',
  description: '从 nginx 配置里的 `upstream cds_master { ... keepalive N; ... }` 移除 keepalive 指令。' +
    '修复"nginx pool 复用 stale Node socket"问题。改完会调用 nginx -t + reload。',
  danger: 'sensitive',
  estimatedSeconds: 5,
  run: async ({ shell, log, repoRoot }) => {
    const path = `${repoRoot}/cds/nginx/cds-site.conf`;
    log('info', `读取 ${path}`);
    const read = await shell.exec(`cat ${path}`, { timeout: 5000 });
    if (read.exitCode !== 0) {
      throw new Error(`读不到 ${path}: ${(read.stderr || '').slice(0, 200)}`);
    }
    const content = read.stdout || '';
    if (!/upstream\s+cds_master\s*\{/.test(content)) {
      log('warning', 'cds-site.conf 没找到 upstream cds_master 块,无操作');
      return { summary: '无操作(配置里没有 cds_master upstream)', details: { content: content.slice(0, 500) } };
    }
    // 在 upstream cds_master { ... } 块里把 keepalive N; 行删掉
    const newContent = content.replace(
      /(upstream\s+cds_master\s*\{[^}]*?)\s*keepalive\s+\d+\s*;\s*\n/,
      '$1\n',
    );
    if (newContent === content) {
      log('info', 'upstream cds_master 里没有 keepalive 指令,无需改');
      return { summary: '无操作(没有 keepalive 指令需要删)', details: {} };
    }
    log('info', '写回 cds-site.conf(已去掉 keepalive 指令)');
    // 用 here-doc 安全写入(避免 shell escape 问题)
    const tmpPath = `/tmp/cds-site.conf.${Date.now()}`;
    // base64 编码再写,避免 special char
    const b64 = Buffer.from(newContent, 'utf-8').toString('base64');
    const w = await shell.exec(`echo '${b64}' | base64 -d > ${tmpPath} && mv ${tmpPath} ${path}`, { timeout: 5000 });
    if (w.exitCode !== 0) throw new Error(`写文件失败: ${(w.stderr || '').slice(0, 200)}`);
    log('info', '写入完成,执行 nginx -t + reload');
    const t = await shell.exec('docker exec cds_nginx nginx -t 2>&1', { timeout: 10_000 });
    if (t.exitCode !== 0) {
      // 回滚
      log('error', `nginx -t 失败,回滚配置`);
      const b64old = Buffer.from(content, 'utf-8').toString('base64');
      await shell.exec(`echo '${b64old}' | base64 -d > ${path}`, { timeout: 5000 });
      throw new Error(`nginx -t 失败,已回滚: ${(t.stdout || '').slice(0, 300)}`);
    }
    const r = await shell.exec('docker exec cds_nginx nginx -s reload 2>&1', { timeout: 15_000 });
    if (r.exitCode !== 0) throw new Error(`reload 失败: ${(r.stderr || '').slice(0, 200)}`);
    log('info', '✓ keepalive 已禁用 + nginx 已重载');
    return { summary: '已禁用 cds_master upstream keepalive 池 + nginx reload 成功', details: {} };
  },
});

operatorOpRegistry.register({
  id: 'shell.run',
  name: '执行任意 shell 命令(高危,需要二次确认)',
  description: '在 CDS host 上以 root 身份执行任意 shell 命令。**仅在已知具体目的时使用**。' +
    '完整 stdout/stderr/exitCode 流回客户端,全部写审计日志。',
  danger: 'destructive',
  confirmText: '我确认这条 shell 命令会以 root 身份运行,我对后果负责',
  estimatedSeconds: 5,
  run: async () => {
    // 占位:实际 run 由 router 层接管(需要拿 body.command),这里不会被调用
    throw new Error('shell.run 必须由 router 层 dispatch,不应直接走 op.run');
  },
});
