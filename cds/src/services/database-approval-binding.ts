import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';

/** Private, persistent key: fingerprints never expose an offline password hash. */
export function databaseApprovalBinding(privateDirectory: string, identity: Record<string, unknown>, password: string): string {
  fs.mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
  const keyPath = path.join(privateDirectory, 'approval-binding.key');
  if (!fs.existsSync(keyPath)) {
    const temporary = path.join(privateDirectory, `.approval-binding-${randomBytes(12).toString('hex')}`);
    try {
      fs.writeFileSync(temporary, randomBytes(32), { flag: 'wx', mode: 0o600 });
      try { fs.linkSync(temporary, keyPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  const stat = fs.lstatSync(keyPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size !== 32) {
    throw new Error('数据库审批密钥不可用，请联系管理员检查后重新申请。');
  }
  const key = fs.readFileSync(keyPath);
  return createHmac('sha256', key).update(JSON.stringify([identity, password])).digest('hex');
}
