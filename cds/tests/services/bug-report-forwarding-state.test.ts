/** CDS 系统级 MAP 缺陷转发配置的持久化与密钥保护契约。 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StateService } from '../../src/services/state.js';

describe('MAP 缺陷转发系统配置', () => {
  let dataDir: string;
  let stateFile: string;
  let previousSecretKey: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-bug-forward-state-'));
    stateFile = path.join(dataDir, 'state.json');
    previousSecretKey = process.env.CDS_SECRET_KEY;
    process.env.CDS_SECRET_KEY = 'test-only-bug-forwarding-secret-key';
  });

  afterEach(() => {
    if (previousSecretKey === undefined) delete process.env.CDS_SECRET_KEY;
    else process.env.CDS_SECRET_KEY = previousSecretKey;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('Token 加密落盘、服务端可解密读取，且清除后不再恢复', async () => {
    const state = new StateService(stateFile, dataDir);
    state.setBugReportForwardingConfig({
      baseUrl: 'https://map.example.com/',
      token: 'sk-ak-never-store-plaintext',
      assigneeUserId: 'user-1',
    });
    await state.getBackingStore().flush?.();

    const raw = fs.readFileSync(stateFile, 'utf8');
    expect(raw).not.toContain('sk-ak-never-store-plaintext');
    expect(JSON.parse(raw).bugReportForwarding.tokenEncrypted).toMatchObject({ __sealed: true });

    const reloaded = new StateService(stateFile, dataDir);
    reloaded.load();
    expect(reloaded.getBugReportForwardingConfig()).toMatchObject({
      baseUrl: 'https://map.example.com',
      token: 'sk-ak-never-store-plaintext',
      assigneeUserId: 'user-1',
    });

    expect(reloaded.clearBugReportForwardingConfig()).toBe(true);
    await reloaded.getBackingStore().flush?.();
    const afterClear = new StateService(stateFile, dataDir);
    afterClear.load();
    expect(afterClear.getBugReportForwardingConfig()).toBeUndefined();
  });
});
