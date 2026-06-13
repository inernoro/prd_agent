import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const scriptPath = path.join(repoRoot, 'cds', 'exec_cds.sh');

function makeHarness() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cds-forwarder-sync-'));
  const cdsDir = path.join(root, 'cds');
  const binDir = path.join(root, 'bin');
  const stateDir = path.join(cdsDir, '.cds');
  mkdirSync(path.join(cdsDir, 'dist', 'forwarder'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  writeFileSync(path.join(cdsDir, 'dist', 'forwarder-main.js'), 'forwarder-main-v1\n');
  writeFileSync(path.join(cdsDir, 'dist', 'forwarder', 'proxy-handler.js'), 'proxy-v1\n');
  writeFileSync(path.join(cdsDir, 'dist', 'widget-script.js'), 'widget-v1\n');
  writeFileSync(path.join(cdsDir, 'dist', 'index.js'), 'admin-v1\n');

  const restartLog = path.join(root, 'restart.log');
  writeFileSync(path.join(binDir, 'systemctl'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if [ "${1:-}" = "is-active" ]; then exit 0; fi',
    'if [ "${1:-}" = "restart" ]; then echo "$*" >> "$CDS_TEST_RESTART_LOG"; exit 0; fi',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH || ''}`,
    CDS_TEST_SCRIPT_DIR: cdsDir,
    CDS_FORWARDER_SELF_SYNC_STATE_DIR: stateDir,
    CDS_TEST_RESTART_LOG: restartLog,
  };

  const run = () => execFileSync('bash', [scriptPath, '__test-forwarder-self-sync'], {
    cwd: cdsDir,
    env,
    encoding: 'utf8',
  });
  const restartCount = () => {
    try {
      return readFileSync(restartLog, 'utf8').trim().split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  };

  return { cdsDir, stateDir, run, restartCount };
}

describe('exec_cds.sh forwarder self-sync', () => {
  it('does not restart forwarder when only admin/master dist changes', () => {
    const h = makeHarness();
    h.run();
    expect(h.restartCount()).toBe(0);

    writeFileSync(path.join(h.cdsDir, 'dist', 'index.js'), 'admin-v2\n');
    h.run();
    expect(h.restartCount()).toBe(0);
  });

  it('restarts forwarder when forwarder runtime files change', () => {
    const h = makeHarness();
    h.run();
    expect(h.restartCount()).toBe(0);

    writeFileSync(path.join(h.cdsDir, 'dist', 'forwarder', 'proxy-handler.js'), 'proxy-v2\n');
    h.run();
    expect(h.restartCount()).toBe(1);

    h.run();
    expect(h.restartCount()).toBe(1);
  });

  it('keeps master startup tolerant when forwarder service is inactive', () => {
    const h = makeHarness();
    const inactiveBin = path.join(h.cdsDir, 'inactive-bin');
    mkdirSync(inactiveBin, { recursive: true });
    writeFileSync(path.join(inactiveBin, 'systemctl'), [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "is-active" ]; then exit 3; fi',
      'if [ "${1:-}" = "restart" ]; then echo "$*" >> "$CDS_TEST_RESTART_LOG"; exit 0; fi',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });

    execFileSync('bash', [scriptPath, '__test-forwarder-self-sync'], {
      cwd: h.cdsDir,
      env: {
        ...process.env,
        PATH: `${inactiveBin}:${process.env.PATH || ''}`,
        CDS_TEST_SCRIPT_DIR: h.cdsDir,
        CDS_FORWARDER_SELF_SYNC_STATE_DIR: h.stateDir,
        CDS_TEST_RESTART_LOG: path.join(h.cdsDir, 'restart.log'),
      },
      encoding: 'utf8',
    });

    expect(h.restartCount()).toBe(0);
  });

  it('keeps signature ownership in master-run only, not forwarder-run', () => {
    const script = readFileSync(scriptPath, 'utf8');
    const forwarderRunCase = script.match(/\n  forwarder-run\)([\s\S]*?)\n  install-forwarder\)/)?.[1] || '';

    expect(forwarderRunCase).not.toContain('record_forwarder_runtime_signature');
    expect(script).toContain('sync_forwarder_if_needed');
  });
});
