/**
 * CDS 预览实例模式（self-hosting MVP，2026-07-15）。
 *
 * 背景：过去验收 CDS 自身改动只能对生产 CDS 做 self-update，任何一次测试都会
 * 重启生产实例、影响所有项目（见 .claude/rules/cross-project-isolation.md 通道 5）。
 * 预览实例模式让「CDS 托管 CDS」成为可能：CDS 分支像普通项目分支一样构建出一个
 * 容器化的子 CDS，通过标准 v3 预览域名访问 dashboard 验收 UI / API 改动。
 *
 * 边界（用户拍板，MVP 只做「自己能被预览」）：
 *   - 子 CDS 不复刻任何宿主能力：不操作 docker、不构建别的项目、不发孙子预览域名；
 *   - 所有宿主操作命令（docker / systemctl / nginx …）被 PreviewInstanceShellExecutor
 *     统一拦截，返回明确的中文提示，而不是让底层报一堆 "command not found"；
 *   - self-update / systemd 同步 / janitor / forwarder 发布等后台服务整体跳过
 *     （index.ts 按 isPreviewInstance() 分流）；
 *   - 存储走容器内 JSON store（不配 CDS_MONGO_URI 即可），首启 seed 演示数据。
 *
 * 激活方式：容器 env 注入 CDS_PREVIEW_INSTANCE=1。
 * 后续路线（本文件不实现）：模拟执行器（假构建）→ DinD 真部署 → cdslab 实验田域名。
 */
import type { IShellExecutor, ExecResult, ExecOptions } from '../types.js';

/** 预览实例开关。读 env，每次调用都重新判定（与 config.masterPort 的 getter 同理由）。 */
export function isPreviewInstance(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CDS_PREVIEW_INSTANCE || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * 预览实例里禁止执行的宿主操作二进制。判定按「每个 shell 片段的首个命令 token」，
 * 兼容 sudo / env / VAR=x 前缀。真正的安全底座是容器根本不挂 docker.sock —— 本
 * 拦截只负责把失败变成一句用户看得懂的话。
 */
export const PREVIEW_INSTANCE_BLOCKED_BINARIES: ReadonlySet<string> = new Set([
  'docker',
  'docker-compose',
  'systemctl',
  'journalctl',
  'nginx',
  'certbot',
  'service',
]);

/**
 * 返回命令里命中的第一个被禁二进制名；未命中返回 null。
 * 按 && / || / ; / | / 换行 拆片段，每个片段跳过 sudo、env、VAR=value 前缀后
 * 取首 token，再剥掉路径前缀（/usr/bin/docker → docker）。
 */
export function findBlockedBinary(command: string): string | null {
  const segments = command.split(/&&|\|\||[;|\n]/g);
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (
      i < tokens.length &&
      (tokens[i] === 'sudo' || tokens[i] === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))
    ) {
      i += 1;
    }
    const bin = tokens[i];
    if (!bin) continue;
    const base = bin.split('/').pop() || bin;
    if (PREVIEW_INSTANCE_BLOCKED_BINARIES.has(base)) return base;
  }
  return null;
}

export function previewInstanceBlockedMessage(binary: string): string {
  return (
    `[preview-instance] 预览实例已禁用宿主操作命令 "${binary}"。` +
    '此实例仅用于验收 CDS 自身的 UI / API 改动，不管理容器、不执行部署；' +
    '需要真实部署请回到生产 CDS 操作。'
  );
}

/**
 * 疑似密钥的 env 键名模式。预览实例是公网可达、跑未合并代码的低信任环境，
 * 父 CDS 的全局变量注入却不区分项目（隔离穿透通道 3，2026-07-15 实测:
 * LLMGW_ADMIN_PASSWORD 被注入子实例容器）。子实例根本不需要这些密钥，
 * 启动最早期整体清除，任何后续信息泄露漏洞都摸不到父实例的秘密。
 */
const SECRET_ENV_KEY_PATTERN = /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)/i;

/** 子实例自用、不许清除的键（basic auth 门用）。 */
const SCRUB_KEEP_KEYS: ReadonlySet<string> = new Set(['CDS_PASSWORD']);

/**
 * 预览实例启动自清洗：从 process.env 删除疑似父实例密钥的变量。
 * 由 load-env.ts 在 .cds.env 注入后立即调用（早于 config.ts 的模块级求值）。
 * 非预览实例是 no-op。返回被清除的键名（不含值），供启动日志留痕。
 */
export function scrubParentSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!isPreviewInstance(env)) return [];
  const scrubbed: string[] = [];
  for (const key of Object.keys(env)) {
    if (SCRUB_KEEP_KEYS.has(key)) continue;
    if (!SECRET_ENV_KEY_PATTERN.test(key)) continue;
    delete env[key];
    scrubbed.push(key);
  }
  if (scrubbed.length > 0) {
    console.log(
      `[preview-instance] 已清除 ${scrubbed.length} 个疑似密钥的环境变量（子实例不持有父实例秘密）: ` +
      scrubbed.sort().join(', '),
    );
  }
  return scrubbed;
}

/**
 * ShellExecutor 装饰器：预览实例模式下拦截宿主操作命令，其余命令
 * （git / node / 文件操作等只读、进程内动作）原样放行。
 */
export class PreviewInstanceShellExecutor implements IShellExecutor {
  constructor(private readonly inner: IShellExecutor) {}

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const blocked = findBlockedBinary(command);
    if (blocked) {
      const message = previewInstanceBlockedMessage(blocked);
      options?.onData?.(`${message}\n`);
      return { stdout: '', stderr: message, exitCode: 1 };
    }
    return this.inner.exec(command, options);
  }
}
