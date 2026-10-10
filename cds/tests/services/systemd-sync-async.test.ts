import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import type { IShellExecutor } from '../../src/types.js';
const native = vi.hoisted(() => ({ exec: vi.fn((command: string) => command.startsWith('command -v ') ? '/usr/bin/' + command.split(' ').at(-1) : '') }));
// The old implementation is measured without ever executing host systemctl.
vi.mock('node:child_process', async importOriginal => ({ ...(await importOriginal<any>()), execSync: native.exec }));
import { syncSystemdUnit, type SystemdUnitSyncOptions } from '../../src/services/systemd-sync.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-unit-async-')); native.exec.mockClear(); vi.spyOn(process, 'getuid').mockReturnValue(0); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(tmp, { recursive: true, force: true }); });
function fixture(restartAfterReload = false) {
  const repoUnit = path.join(tmp, 'repo.service'); const installedUnit = path.join(tmp, 'installed.service');
  fs.writeFileSync(repoUnit, '[Service]\nExecStart=/usr/bin/node /opt/prd_agent/cds/entry\nCPUWeight=10000\nIOWeight=1000\n');
  fs.writeFileSync(installedUnit, 'original-unit');
  return { repoUnit, installedUnit, repoRoot: tmp, cdsDir: path.join(tmp, 'cds'), label: 'test-owned', restartAfterReload };
}
function executor(handler: (command: string, opts: any) => any) {
  return { exec: vi.fn(async (command, opts) => command.startsWith('command -v ') ?
    { stdout: '/usr/bin/' + command.split(' ').at(-1), stderr: '', exitCode: 0 } : handler(command, opts)) } as unknown as IShellExecutor;
}
const ok = { stdout: '', stderr: '', exitCode: 0 };

describe('P2-06 systemd commands run through the shared executor', () => {
  it('keeps reload and restart ordered while a slow command never uses native execSync', async () => {
    const opts = fixture(true); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const shell = executor(async command => { if (command.includes('daemon-reload')) await held; return ok; });
    const pending = syncSystemdUnit(opts, shell);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(native.exec).not.toHaveBeenCalled();
      expect(shell.exec).toHaveBeenCalledWith('systemctl daemon-reload', expect.objectContaining({ timeout: 10000, priority: 'diagnostic', schedulingGroup: 'systemd-sync' }));
      expect((shell.exec as any).mock.calls.some(([command]: string[]) => command.includes('restart'))).toBe(false);
      expect(fs.readFileSync(opts.installedUnit, 'utf8')).not.toBe('original-unit');
      expect(fs.readdirSync(tmp).some(name => name.includes('.bak.'))).toBe(true);
    } finally { release(); await pending; }
    expect(await pending).toMatchObject({ status: 'fixed', restarted: true });
    expect((shell.exec as any).mock.calls.at(-1)[0]).toContain('systemctl restart');
  });

  it('restores the original unit and keeps its backup if asynchronous reload fails', async () => {
    const opts = fixture(true);
    const shell = executor(async () => ({ ...ok, exitCode: 1 }));
    const result = await syncSystemdUnit(opts, shell);
    expect(result.status).toBe('error');
    expect(fs.readFileSync(opts.installedUnit, 'utf8')).toBe('original-unit');
    expect(fs.readdirSync(tmp).filter(name => name.includes('.bak.'))).toHaveLength(1);
    expect((shell.exec as any).mock.calls.some(([command]: string[]) => command.includes('restart'))).toBe(false);
    expect(native.exec).not.toHaveBeenCalled();
  });

  it('applies master runtime weights after reload without restarting master', async () => {
    const shell = executor(async () => ok);
    const result = await syncSystemdUnit(fixture(), shell);
    expect(result).toMatchObject({ status: 'fixed', restarted: false, runtimeWeightsApplied: true });
    expect(shell.exec).toHaveBeenCalledWith(expect.stringContaining('CPUWeight=10000 IOWeight=1000'), expect.any(Object));
    expect((shell.exec as any).mock.calls.some(([command]: string[]) => command.includes('restart'))).toBe(false);
    expect(native.exec).not.toHaveBeenCalled();
  });

  it('does not report a failed forwarder restart as applied', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shell = executor(async command => command.includes('restart') ? { ...ok, exitCode: 1 } : ok);
    const result = await syncSystemdUnit(fixture(true), shell);
    expect(result).toMatchObject({ status: 'fixed', restarted: false });
    expect(native.exec).not.toHaveBeenCalled();
  });
});

function startupBody(): string {
  const source = fs.readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
  const begin = source.indexOf('if (isPreviewInstance()) {', source.indexOf('// systemd unit 自动同步'));
  const end = source.indexOf('// 预览实例首启 seed', begin);
  if (begin < 0 || end < 0) throw new Error('systemd startup boundary missing');
  return ts.transpileModule(source.slice(begin, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
}
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
describe('actual index startup systemd boundary', () => {
  it('passes the existing executor and waits before advancing startup', async () => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const shell = executor(async () => ok);
    const sync = vi.fn(async () => { await held; });
    const log = { log: vi.fn(), warn: vi.fn() }; let done = false;
    const pending = new AsyncFunction('isPreviewInstance', 'config', 'syncAllSystemdUnits', 'shell', 'console', startupBody())(
      () => false, { repoRoot: tmp }, sync, shell, log).then(() => { done = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(sync).toHaveBeenCalledWith(tmp, shell);
      expect(done).toBe(false);
    } finally { release(); await pending; }
    expect(done).toBe(true);
  });

  it('skips host synchronization in preview mode', async () => {
    const sync = vi.fn(); const log = { log: vi.fn(), warn: vi.fn() };
    await new AsyncFunction('isPreviewInstance', 'config', 'syncAllSystemdUnits', 'shell', 'console', startupBody())(
      () => true, { repoRoot: tmp }, sync, executor(async () => ok), log);
    expect(sync).not.toHaveBeenCalled();
  });
});

describe('asynchronous systemd ownership and install controls', () => {
  it('freezes the destination before discovery yields instead of following later caller changes', async () => {
    const opts = fixture(); const original = opts.installedUnit;
    const other = path.join(tmp, 'other.service'); fs.writeFileSync(other, 'other-owned-unit');
    const shell = executor(async () => ok);
    const pending = syncSystemdUnit(opts, shell);
    opts.installedUnit = other;
    const result = await pending;
    expect(result.status).toBe('fixed');
    expect(fs.readFileSync(original, 'utf8')).not.toBe('original-unit');
    expect(fs.readFileSync(other, 'utf8')).toBe('other-owned-unit');
  });

  it('removes a newly installed unit when reload fails without creating a false backup', async () => {
    const opts = { ...fixture(), installIfMissing: true };
    fs.rmSync(opts.installedUnit);
    const result = await syncSystemdUnit(opts, executor(async () => ({ ...ok, exitCode: 124 })));
    expect(result.status).toBe('error'); expect(fs.existsSync(opts.installedUnit)).toBe(false);
    expect(fs.readdirSync(tmp).some(name => name.includes('.bak.'))).toBe(false);
    expect(native.exec).not.toHaveBeenCalled();
  });

  it('keeps the original unit when discovery cannot confirm every executable', async () => {
    const opts = fixture();
    const shell = { exec: vi.fn(async () => ({ ...ok, exitCode: 124 })) } as unknown as IShellExecutor;
    const result = await syncSystemdUnit(opts, shell);
    expect(result).toMatchObject({ status: 'skipped', reason: 'missing node/pnpm/npx in PATH' });
    expect(fs.readFileSync(opts.installedUnit, 'utf8')).toBe('original-unit');
    expect(shell.exec).toHaveBeenCalledWith('command -v node', expect.objectContaining({ timeout: 3000 }));
    expect((shell.exec as any).mock.calls.some(([command]: string[]) => command.includes('systemctl'))).toBe(false);
  });
});

describe('systemd asynchronous unit write ownership', () => {
  it('rejects another writer of the same unit while reload still owns the first write', async () => {
    const opts: SystemdUnitSyncOptions = fixture(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const shell = executor(async command => { if (command.includes('daemon-reload')) await held; return ok; });
    const first = syncSystemdUnit(opts, shell);
    try {
      await vi.waitFor(() => expect(shell.exec).toHaveBeenCalledWith('systemctl daemon-reload', expect.any(Object)));
      const frozenUnit = fs.readFileSync(opts.installedUnit, 'utf8');
      const competingShell = executor(async () => ok);
      const result = await syncSystemdUnit({ ...opts, cdsDir: '/other-owner/cds' }, competingShell);
      expect(result).toMatchObject({ status: 'error', error: 'unit synchronization already in progress' });
      expect(competingShell.exec).not.toHaveBeenCalled();
      expect(fs.readFileSync(opts.installedUnit, 'utf8')).toBe(frozenUnit);
    } finally { release(); await first; }
  });
});

it('bounds distinct in-progress unit identities and releases them after completion', async () => {
  const opts = fixture(); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const shell = { exec: vi.fn(async (command: string) => {
    if (command.startsWith('command -v ')) { await held; return { ...ok, stdout: '/usr/bin/' + command.split(' ').at(-1) }; }
    return ok;
  }) } as unknown as IShellExecutor;
  const pending = Array.from({ length: 32 }, (_, i) => syncSystemdUnit({ ...opts, installedUnit: path.join(tmp, `slot-${i}.service`), installIfMissing: true }, shell));
  try {
    const refused = await syncSystemdUnit({ ...opts, installedUnit: path.join(tmp, 'overflow.service'), installIfMissing: true }, shell);
    expect(refused).toMatchObject({ status: 'error', error: 'unit synchronization capacity exceeded' });
    expect(fs.existsSync(path.join(tmp, 'overflow.service'))).toBe(false);
    expect((shell.exec as any).mock.calls).toHaveLength(32);
  } finally { release(); await Promise.all(pending); }
  const later = await syncSystemdUnit({ ...opts, installedUnit: path.join(tmp, 'later.service'), installIfMissing: true }, executor(async () => ok));
  expect(later.status).toBe('installed');
});

it.each(['symlink', 'hardlink', 'parent-symlink', 'dangling-symlink'] as const)(
  'keeps one physical unit writer when a competing caller uses %s', async kind => {
    const opts: SystemdUnitSyncOptions = fixture(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let alias: string;
    const target = opts.installedUnit;
    if (kind === 'symlink') { alias = path.join(tmp, 'alias.service'); fs.symlinkSync(target, alias); }
    else if (kind === 'hardlink') { alias = path.join(tmp, 'alias.service'); fs.linkSync(target, alias); }
    else if (kind === 'parent-symlink') {
      fs.rmSync(target); const dir = path.join(tmp, 'alias-dir'); fs.symlinkSync(tmp, dir);
      alias = path.join(dir, path.basename(target)); opts.installIfMissing = true;
    } else {
      fs.rmSync(target); alias = path.join(tmp, 'alias.service'); fs.symlinkSync(target, alias); opts.installIfMissing = true;
    }
    const original = { ...opts };
    const shell = { exec: vi.fn(async (command: string) => {
      if (command.startsWith('command -v ')) { await held; return { ...ok, stdout: '/usr/bin/' + command.split(' ').at(-1) }; }
      return ok;
    }) } as unknown as IShellExecutor;
    const first = syncSystemdUnit(original, shell);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      const competingShell = executor(async () => ok);
      const result = await syncSystemdUnit({ ...opts, installedUnit: alias, cdsDir: '/other-writer/cds' }, competingShell);
      expect(result).toMatchObject({ status: 'error', error: 'unit synchronization already in progress' });
      expect(competingShell.exec).not.toHaveBeenCalled();
    } finally { release(); await first; }
    expect(fs.readFileSync(target, 'utf8')).toContain(opts.cdsDir + '/entry');
  });

it('adds the new inode before waiting on reload so a newly created hardlink cannot become a writer', async () => {
  const opts = { ...fixture(), installIfMissing: true }; fs.rmSync(opts.installedUnit);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const shell = executor(async command => { if (command.includes('daemon-reload')) await held; return ok; });
  const first = syncSystemdUnit(opts, shell);
  try {
    await vi.waitFor(() => expect(shell.exec).toHaveBeenCalledWith('systemctl daemon-reload', expect.any(Object)));
    const alias = path.join(tmp, 'new-hardlink.service'); fs.linkSync(opts.installedUnit, alias);
    const competing = executor(async () => ok);
    const result = await syncSystemdUnit({ ...opts, installedUnit: alias, cdsDir: '/another/cds' }, competing);
    expect(result).toMatchObject({ status: 'error', error: 'unit synchronization already in progress' });
    expect(competing.exec).not.toHaveBeenCalled();
  } finally { release(); await first; }
});

it('rejects a symlink that changes its physical destination during discovery', async () => {
  const opts = fixture(true); const target = opts.installedUnit;
  const alias = path.join(tmp, 'service-alias.service'); fs.symlinkSync(target, alias);
  const other = path.join(tmp, 'other-owner.service'); fs.writeFileSync(other, 'other-owner');
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const shell = { exec: vi.fn(async (command: string) => {
    if (command.startsWith('command -v ')) { await held; return { ...ok, stdout: '/usr/bin/' + command.split(' ').at(-1) }; }
    return ok;
  }) } as unknown as IShellExecutor;
  const first = syncSystemdUnit({ ...opts, installedUnit: alias }, shell);
  fs.unlinkSync(alias); fs.symlinkSync(other, alias);
  release(); const result = await first;
  expect(result.status).toBe('error'); expect(fs.readFileSync(target, 'utf8')).toBe('original-unit');
  expect(fs.readFileSync(other, 'utf8')).toBe('other-owner');
  expect((shell.exec as any).mock.calls.some(([command]: string[]) => command.includes('systemctl'))).toBe(false);
});

it('fails before command discovery when the dangling target parent cannot be identified', async () => {
  const opts = fixture(); const alias = path.join(tmp, 'unresolved-alias.service');
  fs.symlinkSync(path.join(tmp, 'missing-parent', 'unit.service'), alias);
  const shell = executor(async () => ok);
  const result = await syncSystemdUnit({ ...opts, installedUnit: alias, installIfMissing: true }, shell);
  expect(result).toMatchObject({ status: 'error', error: 'unit path identity unavailable' });
  expect(shell.exec).not.toHaveBeenCalled();
});

it('preserves a linked unit name even when its outside target filename is not a unit name', async () => {
  const opts = fixture(true); const target = path.join(tmp, 'external-config.txt');
  fs.writeFileSync(target, 'external-original');
  const alias = path.join(tmp, 'linked-unit.service'); fs.symlinkSync(target, alias);
  const shell = executor(async () => ok);
  const result = await syncSystemdUnit({ ...opts, installedUnit: alias }, shell);
  expect(result).toMatchObject({ status: 'fixed', restarted: true });
  expect(fs.readFileSync(target, 'utf8')).toContain(opts.cdsDir + '/entry');
  expect(shell.exec).toHaveBeenCalledWith("systemctl restart 'linked-unit.service'", expect.any(Object));
});

it('restores only the frozen target and avoids restart when its link changes during reload', async () => {
  const opts = fixture(true); const target = opts.installedUnit;
  const alias = path.join(tmp, 'during-reload.service'); fs.symlinkSync(target, alias);
  const other = path.join(tmp, 'another-owner.service'); fs.writeFileSync(other, 'another-owner');
  const shell = executor(async command => {
    if (command.includes('daemon-reload')) { fs.unlinkSync(alias); fs.symlinkSync(other, alias); }
    return ok;
  });
  const result = await syncSystemdUnit({ ...opts, installedUnit: alias }, shell);
  expect(result.status).toBe('error'); expect(fs.readFileSync(target, 'utf8')).toBe('original-unit');
  expect(fs.readFileSync(other, 'utf8')).toBe('another-owner');
  expect((shell.exec as any).mock.calls.some(([command]: string[]) => command.includes('restart'))).toBe(false);
});

it.each(['replacement', 'symlink'] as const)('does not roll back over a foreign %s at the frozen target', async kind => {
  const opts = fixture(true); const moved = path.join(tmp, 'held-original');
  const other = path.join(tmp, 'foreign-target'); fs.writeFileSync(other, 'foreign-owner');
  const shell = executor(async command => {
    if (command.includes('daemon-reload')) {
      fs.renameSync(opts.installedUnit, moved);
      if (kind === 'symlink') fs.symlinkSync(other, opts.installedUnit);
      else fs.writeFileSync(opts.installedUnit, 'foreign-owner');
    }
    return ok;
  });
  const result = await syncSystemdUnit(opts, shell);
  expect(result.status).toBe('error');
  expect(fs.readFileSync(opts.installedUnit, 'utf8')).toBe('foreign-owner');
  expect(fs.readFileSync(other, 'utf8')).toBe('foreign-owner');
  expect(fs.readFileSync(moved, 'utf8')).toContain(opts.cdsDir + '/entry');
  expect(fs.readdirSync(tmp).filter(name => name.includes('.bak.'))).toHaveLength(1);
  expect((shell.exec as any).mock.calls.some(([command]: string[]) => command.includes('restart'))).toBe(false);
});

it('does not remove a foreign replacement after first installation loses its target ownership', async () => {
  const opts = { ...fixture(), installIfMissing: true }; fs.rmSync(opts.installedUnit);
  const moved = path.join(tmp, 'created-original');
  const shell = executor(async command => {
    if (command.includes('daemon-reload')) {
      fs.renameSync(opts.installedUnit, moved); fs.writeFileSync(opts.installedUnit, 'foreign-owner');
    }
    return ok;
  });
  const result = await syncSystemdUnit(opts, shell);
  expect(result.status).toBe('error');
  expect(fs.existsSync(opts.installedUnit)).toBe(true);
  expect(fs.readFileSync(opts.installedUnit, 'utf8')).toBe('foreign-owner');
  expect(fs.readFileSync(moved, 'utf8')).toContain(opts.cdsDir + '/entry');
});

it('rejects changed requested binding even if the original unit has no drift', async () => {
  const opts = fixture(true); await syncSystemdUnit(opts, executor(async () => ok));
  const desired = fs.readFileSync(opts.installedUnit, 'utf8');
  const alias = path.join(tmp, 'no-drift-alias.service'); fs.symlinkSync(opts.installedUnit, alias);
  const other = path.join(tmp, 'foreign-target'); fs.writeFileSync(other, 'foreign-owner');
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const shell = { exec: vi.fn(async (command: string) => {
    if (command.startsWith('command -v ')) { await held; return { ...ok, stdout: '/usr/bin/' + command.split(' ').at(-1) }; }
    return ok;
  }) } as unknown as IShellExecutor;
  const pending = syncSystemdUnit({ ...opts, installedUnit: alias }, shell);
  fs.unlinkSync(alias); fs.symlinkSync(other, alias); release();
  expect((await pending).status).toBe('error');
  expect(fs.readFileSync(opts.installedUnit, 'utf8')).toBe(desired);
  expect(fs.readFileSync(other, 'utf8')).toBe('foreign-owner');
  expect((shell.exec as any).mock.calls.some(([command]: string[]) => command.includes('systemctl'))).toBe(false);
});

it.each(['weights', 'restart'] as const)('does not report a %s outcome as applied after binding changes during the command', async mode => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const opts = fixture(mode === 'restart'); const target = opts.installedUnit;
  const alias = path.join(tmp, 'last-command.service'); fs.symlinkSync(target, alias);
  const other = path.join(tmp, 'foreign-target'); fs.writeFileSync(other, 'foreign-owner');
  const shell = executor(async command => {
    if (command.includes(mode === 'restart' ? 'systemctl restart' : 'systemctl set-property')) {
      fs.unlinkSync(alias); fs.symlinkSync(other, alias);
    }
    return ok;
  });
  const result = await syncSystemdUnit({ ...opts, installedUnit: alias }, shell);
  expect(result).toMatchObject({ status: 'error', error: 'unit path binding changed; systemd outcome requires reconciliation' });
  expect(result).not.toMatchObject({ restarted: true });
  expect(result).not.toMatchObject({ runtimeWeightsApplied: true });
  expect(fs.readFileSync(other, 'utf8')).toBe('foreign-owner');
  expect(fs.readFileSync(target, 'utf8')).toContain(opts.cdsDir + '/entry');
});
