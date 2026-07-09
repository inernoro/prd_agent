import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const scriptPath = path.join(repoRoot, 'cds/scripts/local-prod-release.sh');

let tmpDir = '';
let binDir = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-local-prod-release-'));
  binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFakeCommand(name: string): void {
  fs.writeFileSync(path.join(binDir, name), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
}

describe('local-prod-release.sh', () => {
  it('fails fast with a clear error when healthcheck is enabled but curl is missing', () => {
    writeFakeCommand('docker');
    writeFakeCommand('rsync');
    const sourceDir = path.join(tmpDir, 'source');
    const prodDir = path.join(tmpDir, 'prod');
    fs.mkdirSync(sourceDir, { recursive: true });

    const result = spawnSync('/bin/bash', [scriptPath], {
      encoding: 'utf8',
      env: {
        PATH: binDir,
        CDS_LOCAL_PROD_ALLOWED_BRANCH: 'main',
        CDS_BRANCH_NAME: 'main',
        CDS_PROJECT_ID: 'proj-a',
        CDS_BRANCH_ID: 'branch-a',
        CDS_LOCAL_PROD_SOURCE_DIR: sourceDir,
        CDS_LOCAL_PROD_DIR: prodDir,
        CDS_LOCAL_PROD_HEALTH_URL: 'http://127.0.0.1:9/health',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing command: curl');
    expect(result.stdout).not.toContain('sync source');
  });
});
