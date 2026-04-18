import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEnvFileOps } from '../../src/infra/env-file.js';

describe('env-file', () => {
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envfile-'));
    envPath = path.join(dir, '.cds.env');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('upsert creates file with single export line on first call', () => {
    const ops = createEnvFileOps(envPath);
    ops.upsert('CDS_MONGO_URI', 'mongodb://localhost:27017');
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('export CDS_MONGO_URI="mongodb://localhost:27017"');
  });

  it('upsert replaces existing line atomically (not duplicates)', () => {
    const ops = createEnvFileOps(envPath);
    ops.upsert('CDS_MONGO_URI', 'mongodb://old:27017');
    ops.upsert('CDS_MONGO_URI', 'mongodb://new:27017');
    const content = fs.readFileSync(envPath, 'utf-8');
    const matches = content.match(/CDS_MONGO_URI/g);
    expect(matches?.length).toBe(1);
    expect(content).toContain('mongodb://new:27017');
    expect(content).not.toContain('mongodb://old:27017');
  });

  it('upsert preserves unrelated lines', () => {
    fs.writeFileSync(envPath, [
      '# CDS config',
      'export CDS_HOST="example.com"',
      'export CDS_PORT="9900"',
      '',
    ].join('\n'));
    const ops = createEnvFileOps(envPath);
    ops.upsert('CDS_MONGO_URI', 'mongodb://localhost:27017');
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('CDS_HOST="example.com"');
    expect(content).toContain('CDS_PORT="9900"');
    expect(content).toContain('CDS_MONGO_URI="mongodb://localhost:27017"');
  });

  it('removeKey deletes all lines for that key', () => {
    const ops = createEnvFileOps(envPath);
    ops.upsert('CDS_STORAGE_MODE', 'mongo');
    ops.upsert('CDS_MONGO_URI', 'mongodb://localhost:27017');
    ops.upsert('CDS_MONGO_DB', 'cds_state_db');
    ops.removeKey('CDS_MONGO_URI');
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).not.toContain('CDS_MONGO_URI');
    expect(content).toContain('CDS_STORAGE_MODE');
    expect(content).toContain('CDS_MONGO_DB');
  });

  it('escapes " and \\ in values (bash double-quoted safe)', () => {
    const ops = createEnvFileOps(envPath);
    ops.upsert('TRICKY', 'has "quotes" and \\ backslash');
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('has \\"quotes\\" and \\\\ backslash');
  });

  it('escapes $ to prevent accidental shell expansion', () => {
    const ops = createEnvFileOps(envPath);
    ops.upsert('PASSWORD', 'has$dollar');
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('has\\$dollar');
  });

  it('rejects invalid keys', () => {
    const ops = createEnvFileOps(envPath);
    expect(() => ops.upsert('bad-key', 'v')).toThrow();
    expect(() => ops.upsert('1STARTS_WITH_NUMBER', 'v')).toThrow();
    expect(() => ops.upsert('has space', 'v')).toThrow();
  });

  it('file is chmod 0600 after write', () => {
    const ops = createEnvFileOps(envPath);
    ops.upsert('SECRET', 's3cret');
    const mode = fs.statSync(envPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('removeKey is no-op when file does not exist', () => {
    const ops = createEnvFileOps(envPath);
    expect(() => ops.removeKey('CDS_MONGO_URI')).not.toThrow();
  });
});
