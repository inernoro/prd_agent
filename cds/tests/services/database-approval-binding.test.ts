import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { databaseApprovalBinding } from '../../src/services/database-approval-binding.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })));
describe('private database approval binding', () => {
  it('survives restart, binds credentials and physical target, never persists credentials', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'db-approval-key-')); directories.push(directory);
    const identity = { database: 'qa', port: 23000, containerId: 'a'.repeat(64) };
    const bound = databaseApprovalBinding(directory, identity, 'fixture-private');
    expect(databaseApprovalBinding(directory, identity, 'fixture-private')).toBe(bound);
    expect(databaseApprovalBinding(directory, identity, 'rotated')).not.toBe(bound);
    expect(databaseApprovalBinding(directory, { ...identity, containerId: 'b'.repeat(64) }, 'fixture-private')).not.toBe(bound);
    const keyPath = path.join(directory, 'approval-binding.key');
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(keyPath)).toHaveLength(32);
    expect(fs.readFileSync(keyPath).toString()).not.toContain('fixture-private');
    fs.chmodSync(keyPath, 0o644);
    expect(() => databaseApprovalBinding(directory, identity, 'fixture-private')).toThrow('审批密钥不可用');
  });
});
