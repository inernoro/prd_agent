/**
 * systemd-sync 单元测试 — 验证 drift 检测 + 模板渲染
 *
 * 真实 syncSystemdUnit() 会写 /etc/systemd/system 和调 systemctl,
 * 这里只测 renderDesiredUnit() 的纯函数 + 分支逻辑。
 */
import { describe, it, expect } from 'vitest';
import { renderDesiredUnit, syncSystemdUnit } from '../../src/services/systemd-sync.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('renderDesiredUnit', () => {
  const template = `[Unit]
Description=CDS Master
After=network.target

[Service]
WorkingDirectory=/opt/prd_agent/cds
ExecStart=/opt/prd_agent/cds/exec_cds.sh master-run
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=PNPM_HOME=/opt/prd_agent/cds/.pnpm
ExecReload=/usr/bin/pnpm reload
Restart=always

[Install]
WantedBy=multi-user.target
`;

  it('替换 /opt/prd_agent → repoRoot 的所有出现', () => {
    const out = renderDesiredUnit(template, {
      repoRoot: '/home/dev/prd-agent',
      cdsDir: '/home/dev/prd-agent/cds',
      nodeBin: '/usr/bin/node',
      pnpmBin: '/usr/bin/pnpm',
      npxBin: '/usr/bin/npx',
    });
    expect(out).not.toContain('/opt/prd_agent');
    expect(out).toContain('/home/dev/prd-agent/cds');
    expect(out).toContain('PNPM_HOME=/home/dev/prd-agent/cds/.pnpm');
  });

  it('注入 nvm/asdf 风格的 nodeBinDir 到 PATH 头部', () => {
    const out = renderDesiredUnit(template, {
      repoRoot: '/opt/prd_agent',
      cdsDir: '/opt/prd_agent/cds',
      nodeBin: '/root/.nvm/versions/node/v22.5.0/bin/node',
      pnpmBin: '/root/.nvm/versions/node/v22.5.0/bin/pnpm',
      npxBin: '/root/.nvm/versions/node/v22.5.0/bin/npx',
    });
    // PATH 行第一段应该是 nodeBinDir
    expect(out).toMatch(
      /^Environment=PATH=\/root\/\.nvm\/versions\/node\/v22\.5\.0\/bin:/m,
    );
  });

  it('替换 /usr/bin/{node,pnpm,npx} 为绝对路径', () => {
    const out = renderDesiredUnit(template, {
      repoRoot: '/opt/prd_agent',
      cdsDir: '/opt/prd_agent/cds',
      nodeBin: '/custom/node',
      pnpmBin: '/custom/pnpm',
      npxBin: '/custom/npx',
    });
    expect(out).toContain('/custom/pnpm reload');
    expect(out).not.toContain('/usr/bin/pnpm');
  });

  it('对已经渲染过的 unit 是幂等的(同一份模板再走一次得到同样结果)', () => {
    const opts = {
      repoRoot: '/opt/prd_agent',
      cdsDir: '/opt/prd_agent/cds',
      nodeBin: '/usr/bin/node',
      pnpmBin: '/usr/bin/pnpm',
      npxBin: '/usr/bin/npx',
    };
    const a = renderDesiredUnit(template, opts);
    const b = renderDesiredUnit(a, opts);
    expect(a).toBe(b);
  });
});

describe('systemd unit templates', () => {
  it('master unit allows writing /etc/systemd/system for self-sync under ProtectSystem=strict', () => {
    const unit = fs.readFileSync(
      path.resolve(__dirname, '../../systemd/cds-master.service'),
      'utf8',
    );
    expect(unit).toMatch(/^ProtectSystem=strict$/m);
    const readWritePaths = unit
      .split('\n')
      .find(line => line.startsWith('ReadWritePaths='));
    expect(readWritePaths).toContain('/etc/systemd/system');
  });

  // 2026-09-08 宿主过载复盘：控制面只划优先级不设上限——单元里必须有权重、不得出现 CPUQuota。
  it('master/forwarder units carry CPU/IO weight (priority) but no CPUQuota (limit)', () => {
    for (const name of ['cds-master.service', 'cds-forwarder.service']) {
      const unit = fs.readFileSync(path.resolve(__dirname, '../../systemd', name), 'utf8');
      expect(unit, name).toMatch(/^CPUWeight=1000$/m);
      expect(unit, name).toMatch(/^IOWeight=1000$/m);
      expect(unit, name).not.toMatch(/^CPUQuota=/m);
    }
  });

  it('workload slice nests under system.slice with low weight and is the value container.ts passes to docker', () => {
    const slice = fs.readFileSync(path.resolve(__dirname, '../../systemd/system-cdsworkloads.slice'), 'utf8');
    expect(slice).toMatch(/^\[Slice\]$/m);
    expect(slice).toMatch(/^CPUWeight=100$/m);
    expect(slice).toMatch(/^IOWeight=100$/m);
    // 默认 slice 名与单元文件名必须同源，否则 docker 引用的 slice 没有权重文件。
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/workload-cgroup.ts'), 'utf8');
    expect(src).toContain("DEFAULT_WORKLOAD_SLICE = 'system-cdsworkloads.slice'");
  });
});

describe('syncSystemdUnit branching', () => {
  it('repoUnit 不存在时 skipped', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sysd-sync-'));
    try {
      const r = syncSystemdUnit({
        repoUnit: path.join(tmp, 'does-not-exist.service'),
        installedUnit: path.join(tmp, 'installed.service'),
        repoRoot: '/x',
        cdsDir: '/x/cds',
        label: 't',
        restartAfterReload: false,
      });
      expect(r.status).toBe('skipped');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('installedUnit 不存在时 skipped(dev 环境)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sysd-sync-'));
    try {
      fs.writeFileSync(path.join(tmp, 'repo.service'), 'X');
      const r = syncSystemdUnit({
        repoUnit: path.join(tmp, 'repo.service'),
        installedUnit: path.join(tmp, 'no-such.service'),
        repoRoot: '/x',
        cdsDir: '/x/cds',
        label: 't',
        restartAfterReload: false,
      });
      expect(r.status).toBe('skipped');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('installIfMissing 时「未安装」不再当 dev 环境跳过（只可能卡在非 root）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sysd-sync-'));
    try {
      fs.writeFileSync(path.join(tmp, 'repo.slice'), '[Slice]\nCPUWeight=100\n');
      const r = syncSystemdUnit({
        repoUnit: path.join(tmp, 'repo.slice'),
        installedUnit: path.join(tmp, 'no-such.slice'),
        repoRoot: '/x',
        cdsDir: '/x/cds',
        label: 't',
        restartAfterReload: false,
        installIfMissing: true,
      });
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        expect(r.status).toBe('skipped');
        expect((r as { reason: string }).reason).not.toContain('not installed');
      } else {
        expect(['installed', 'error']).toContain(r.status);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('非 root 时 skipped(测试环境本来就不是 root)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sysd-sync-'));
    try {
      fs.writeFileSync(path.join(tmp, 'repo.service'), 'X');
      fs.writeFileSync(path.join(tmp, 'installed.service'), 'Y');
      const r = syncSystemdUnit({
        repoUnit: path.join(tmp, 'repo.service'),
        installedUnit: path.join(tmp, 'installed.service'),
        repoRoot: '/x',
        cdsDir: '/x/cds',
        label: 't',
        restartAfterReload: false,
      });
      // 测试环境通常 !root → skipped。如果以 root 跑测试,函数会尝试写
      // 系统路径,但路径在 tmp 里 + 非 systemd 服务,这条仍然会到 'fixed'
      // 或 'error'(daemon-reload 失败)。两者都不算意外行为,但默认情况
      // 我们期望 skipped。
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        expect(r.status).toBe('skipped');
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
