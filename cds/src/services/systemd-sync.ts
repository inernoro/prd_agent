/**
 * systemd unit 自动同步 — 让自更新无需 SSH
 *
 * 当 daemon 进程以 root 身份启动时(systemd 拉起时永远是 root),如果检测到
 * /etc/systemd/system/cds-*.service 与 repo 模板有实质 drift,就自动:
 *   1. 备份旧 unit 到 .bak.<ts>
 *   2. 写入按当前安装路径插值后的新 unit
 *   3. systemctl daemon-reload(让 systemd 看到新 ExecStart / PATH)
 *   4. (forwarder)trigger restart so the new ExecStart 生效;master 已经在跑
 *      新 daemon,不需要再次自重启
 *
 * 触发时机:
 *   - daemon 启动时(index.ts startup)— 主要触发路径
 *   - exec_cds.sh master-run 也会拉新 forwarder 进程,补一道兜底
 *
 * 跳过条件(任一):
 *   - 没装 systemd unit(/etc/systemd/system/cds-master.service 不存在)→ dev 环境
 *   - 不是 root → 写不动 /etc,留 drift banner 提醒手动
 *   - 缺 node/pnpm/npx → 没法生成 unit
 *   - 文件 hash 一致 → 无 drift,什么都不做
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export interface SystemdUnitSyncOptions {
  /** repo 中的 unit 模板路径,例 /opt/prd_agent/cds/systemd/cds-master.service */
  repoUnit: string;
  /** 系统已装的 unit 路径,例 /etc/systemd/system/cds-master.service */
  installedUnit: string;
  /** repoRoot,通常 /opt/prd_agent;用于 sed 替换 /opt/prd_agent → repoRoot */
  repoRoot: string;
  /** cdsDir,通常 /opt/prd_agent/cds */
  cdsDir: string;
  /** 标签,日志前缀,例 'cds-master' / 'cds-forwarder' */
  label: string;
  /** drift 修复后是否要 systemctl restart 这个服务?
   *   - master: false(自身正在跑新版本,daemon-reload 后下次自然重启时生效)
   *   - forwarder: true(forwarder 是独立进程,daemon-reload 后必须 restart 才能切到新 ExecStart) */
  restartAfterReload: boolean;
}

export type SystemdUnitSyncResult =
  | { status: 'skipped'; reason: string }
  | { status: 'no-drift' }
  | { status: 'fixed'; backupPath: string; restarted: boolean }
  | { status: 'error'; error: string };

function whichBin(cmd: string): string {
  try {
    return execSync(`command -v ${cmd}`, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * Render the desired unit text by substituting install paths into the repo template.
 * Mirrors exec_cds.sh `install_systemd_cmd` / `install_forwarder_cmd` sed chain.
 */
export function renderDesiredUnit(template: string, opts: {
  repoRoot: string;
  cdsDir: string;
  nodeBin: string;
  pnpmBin: string;
  npxBin: string;
}): string {
  const nodeBinDir = path.dirname(opts.nodeBin);
  return template
    .replace(/\/opt\/prd_agent\/cds/g, opts.cdsDir)
    .replace(/\/opt\/prd_agent/g, opts.repoRoot)
    .replace(/\/usr\/bin\/pnpm/g, opts.pnpmBin)
    .replace(/\/usr\/bin\/node/g, opts.nodeBin)
    .replace(/\/usr\/bin\/npx/g, opts.npxBin)
    .replace(
      /^Environment=PATH=.*$/m,
      `Environment=PATH=${nodeBinDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    );
}

export function syncSystemdUnit(opts: SystemdUnitSyncOptions): SystemdUnitSyncResult {
  if (!fs.existsSync(opts.installedUnit)) {
    return { status: 'skipped', reason: `${opts.installedUnit} not installed (dev env?)` };
  }
  if (!fs.existsSync(opts.repoUnit)) {
    return { status: 'skipped', reason: `${opts.repoUnit} not in repo` };
  }
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (!isRoot) {
    return { status: 'skipped', reason: 'not running as root, /etc/systemd/system not writable' };
  }
  const nodeBin = whichBin('node');
  const pnpmBin = whichBin('pnpm');
  const npxBin = whichBin('npx');
  if (!nodeBin || !pnpmBin || !npxBin) {
    return { status: 'skipped', reason: 'missing node/pnpm/npx in PATH' };
  }

  let template: string;
  let installed: string;
  try {
    template = fs.readFileSync(opts.repoUnit, 'utf8');
    installed = fs.readFileSync(opts.installedUnit, 'utf8');
  } catch (err) {
    return { status: 'error', error: `read failed: ${(err as Error).message}` };
  }

  const desired = renderDesiredUnit(template, {
    repoRoot: opts.repoRoot,
    cdsDir: opts.cdsDir,
    nodeBin,
    pnpmBin,
    npxBin,
  });

  if (installed === desired) {
    return { status: 'no-drift' };
  }

  const backupPath = `${opts.installedUnit}.bak.${Date.now()}`;
  try {
    fs.copyFileSync(opts.installedUnit, backupPath);
  } catch (err) {
    return { status: 'error', error: `backup failed: ${(err as Error).message}` };
  }
  try {
    fs.writeFileSync(opts.installedUnit, desired);
    execSync('systemctl daemon-reload', { stdio: 'pipe', timeout: 10_000 });
  } catch (err) {
    // 回滚
    try { fs.copyFileSync(backupPath, opts.installedUnit); } catch { /* */ }
    return { status: 'error', error: `write/daemon-reload failed: ${(err as Error).message}` };
  }

  // Forwarder 不重启就用不到新 ExecStart;master 自己已经是新进程,不再自重启。
  let restarted = false;
  if (opts.restartAfterReload) {
    try {
      const unitName = path.basename(opts.installedUnit); // e.g. cds-forwarder.service
      execSync(`systemctl restart ${unitName}`, { stdio: 'pipe', timeout: 15_000 });
      restarted = true;
    } catch (err) {
      // 重启失败不算修复失败 — drift 已修,只是没立刻生效。下次手动 / 重启
      // 服务时即可加载新 ExecStart。
      console.warn(`  [systemd-sync:${opts.label}] daemon-reload OK 但 restart 失败: ${(err as Error).message}`);
    }
  }

  return { status: 'fixed', backupPath, restarted };
}

/**
 * Convenience entry point: sync both master + forwarder units.
 * Logs a one-line summary per unit.
 */
export function syncAllSystemdUnits(repoRoot: string): {
  master: SystemdUnitSyncResult;
  forwarder: SystemdUnitSyncResult;
} {
  const cdsDir = path.resolve(repoRoot, 'cds');

  const master = syncSystemdUnit({
    repoUnit: path.resolve(cdsDir, 'systemd', 'cds-master.service'),
    installedUnit: '/etc/systemd/system/cds-master.service',
    repoRoot,
    cdsDir,
    label: 'cds-master',
    restartAfterReload: false,
  });
  logResult('cds-master', master);

  const forwarder = syncSystemdUnit({
    repoUnit: path.resolve(cdsDir, 'systemd', 'cds-forwarder.service'),
    installedUnit: '/etc/systemd/system/cds-forwarder.service',
    repoRoot,
    cdsDir,
    label: 'cds-forwarder',
    restartAfterReload: true,
  });
  logResult('cds-forwarder', forwarder);

  return { master, forwarder };
}

function logResult(label: string, r: SystemdUnitSyncResult): void {
  switch (r.status) {
    case 'skipped':
      console.log(`  [systemd-sync:${label}] skipped — ${r.reason}`);
      break;
    case 'no-drift':
      // 无 drift 不打日志 — 99% 启动都走这条,刷屏没意义
      break;
    case 'fixed':
      console.log(
        `  [systemd-sync:${label}] drift 已修复(备份 ${r.backupPath}${r.restarted ? ',已 systemctl restart' : ',下次重启生效'})`,
      );
      break;
    case 'error':
      console.warn(`  [systemd-sync:${label}] failed: ${r.error}`);
      break;
  }
}
