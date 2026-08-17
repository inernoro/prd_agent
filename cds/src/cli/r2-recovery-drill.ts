import { fileURLToPath } from 'node:url';
import { r2BackupConfigFromEnv } from '../services/infra-backup-r2.js';
import { runMongoR2RecoveryDrill } from '../services/infra-r2-recovery-drill.js';

function arg(name: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 ? String(process.argv[at + 1] || '').trim() : '';
}

export async function main(): Promise<void> {
  const objectKey = arg('--object-key');
  const mongoImage = arg('--mongo-image') || undefined;
  const config = r2BackupConfigFromEnv();
  if (!objectKey) throw new Error('缺少 --object-key');
  if (!config) throw new Error('缺少完整 R2 环境配置');

  const result = await runMongoR2RecoveryDrill({ config, objectKey, mongoImage });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
