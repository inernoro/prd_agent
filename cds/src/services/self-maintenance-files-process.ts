import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceDirectoriesAtomically } from './atomic-directory-replacement.js';
import { maintenanceDirectoryIdentity, markRetentionDisposition, forgetRetention, retireRetainedCheckpoint,
  type MaintenanceDirectoryIdentity, type MaintenanceRetirement } from './self-maintenance-retention.js';
export { maintenanceDirectoryIdentity, type MaintenanceDirectoryIdentity } from './self-maintenance-retention.js';

const directories = ['dist', 'web/dist', 'web/dist.previous', 'node_modules', 'web/node_modules'] as const;
export type MaintenanceFilesAction = 'snapshot' | 'restore' | 'discard' | 'retire';
export interface MaintenanceFilesInput {
  action: MaintenanceFilesAction;
  ownerId: string;
  root: MaintenanceDirectoryIdentity;
  backup: MaintenanceDirectoryIdentity;
  existed?: boolean[];
  retirement?: MaintenanceRetirement;
}
export interface MaintenanceFilesReceipt {
  action: MaintenanceFilesAction;
  ownerId: string;
  existed: boolean[];
  artifactsRestored: boolean;
}

function sameIdentity(identity: MaintenanceDirectoryIdentity): boolean {
  const actual = maintenanceDirectoryIdentity(identity.path);
  return actual.dev === identity.dev && actual.ino === identity.ino;
}

export function verifyMaintenanceFilesInput(input: MaintenanceFilesInput): void {
  if (!input || !['snapshot', 'restore', 'discard', 'retire'].includes(input.action)
    || !/^[a-f0-9-]{36}$/.test(input.ownerId) || !input.root || !input.backup
    || !path.isAbsolute(input.root.path) || !path.isAbsolute(input.backup.path)) {
    throw new Error('CDS 维护文件请求无效，已停止操作。');
  }
  const cds = path.join(input.root.path, 'cds');
  maintenanceDirectoryIdentity(cds);
  maintenanceDirectoryIdentity(path.join(cds, 'web'));
  const base = path.join(cds, '.cds');
  maintenanceDirectoryIdentity(base);
  const backupOwner = input.action === 'retire' ? input.retirement?.replacementOwnerId : input.ownerId;
  if (!sameIdentity(input.root) || !sameIdentity(input.backup)
    || path.dirname(input.backup.path) !== base
    || !backupOwner || !/^[a-f0-9-]{36}$/.test(backupOwner)
    || !new RegExp(`^restart-rollback-${backupOwner}-[A-Za-z0-9]{6}$`).test(path.basename(input.backup.path))
    || input.action !== 'snapshot' && (!Array.isArray(input.existed)
      || input.existed.length !== directories.length || input.existed.some(value => typeof value !== 'boolean'))) {
    throw new Error('CDS 维护目录已变化，已保留恢复点并停止操作。');
  }
}

/** 私有stdin仅允许原五目录动作及精确两槽退役，没有任意路径删除或RPC。 */
export async function maintainFiles(input: MaintenanceFilesInput): Promise<MaintenanceFilesReceipt> {
  verifyMaintenanceFilesInput(input);
  if (input.action === 'retire') {
    retireRetainedCheckpoint(input.root, input.retirement!);
    return { action: 'retire', ownerId: input.ownerId, existed: [...input.existed!], artifactsRestored: false };
  }
  const cds = path.join(input.root.path, 'cds');
  const copies = directories.map((relative, index) => ({
    currentPath: path.join(cds, relative), nextPath: path.join(input.backup.path, String(index)),
    existed: input.action === 'snapshot' ? fs.existsSync(path.join(cds, relative)) : input.existed![index],
    preserveLinks: relative.endsWith('node_modules'),
  }));
  if (input.action === 'snapshot') {
    if (fs.readdirSync(input.backup.path).length) throw new Error('CDS 维护恢复点并非空目录，已停止复制。');
    for (const copy of copies) if (copy.existed) await fs.promises.cp(copy.currentPath, copy.nextPath, {
      recursive: true, dereference: !copy.preserveLinks, verbatimSymlinks: copy.preserveLinks,
      mode: fs.constants.COPYFILE_FICLONE,
    });
  } else if (input.action === 'restore') {
    markRetentionDisposition(input.root, input.ownerId, 'restoring', input.existed!);
    replaceDirectoriesAtomically(copies.filter(copy => copy.existed));
    for (const copy of copies) if (!copy.existed) fs.rmSync(copy.currentPath, { recursive: true, force: true });
  } else {
    markRetentionDisposition(input.root, input.ownerId, 'discarding', input.existed!);
    fs.rmSync(input.backup.path, { recursive: true, force: true });
    forgetRetention(input.root, input.ownerId);
  }
  return { action: input.action, ownerId: input.ownerId, existed: copies.map(copy => copy.existed),
    artifactsRestored: input.action === 'restore' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes > 4096) throw new Error('Maintenance file input budget exceeded');
      chunks.push(buffer);
    }
    process.stdout.write(JSON.stringify(await maintainFiles(JSON.parse(Buffer.concat(chunks).toString('utf8')))));
  } catch {
    process.stderr.write('CDS 维护文件操作未完成，已保留可用恢复点，请核对维护状态。');
    process.exitCode = 1;
  }
}
