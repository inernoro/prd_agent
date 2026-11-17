import { fileURLToPath } from 'node:url';
import { r2BackupConfigFromEnv } from '../services/infra-backup-r2.js';
import { runMongoR2RecoveryDrill } from '../services/infra-r2-recovery-drill.js';

function arg(name: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 ? String(process.argv[at + 1] || '').trim() : '';
}

export async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write('隔离恢复演练：--object-key <精确R2对象键> --mongo-image <本机已有的源库同版本镜像>\n'
      + '预算可选：--max-archive-bytes（默认4GiB） --data-bytes（默认8GiB tmpfs） --memory-bytes（默认10GiB） --timeout-ms（默认600000，最大3600000）\n'
      + '对象固定可选：--expected-bytes <已核对字节数> --expected-sha256 <已核对的小写SHA-256>，须成对传入；不匹配时不下载。\n'
      + '固定2CPU、无网络和公开端口；不自动拉取镜像。先核对授权、源库版本和主机余量。清场未确认会保留资源并拒绝成功回执。\n');
    return;
  }
  const objectKey = arg('--object-key');
  const mongoImage = arg('--mongo-image') || undefined;
  const expectedBytes = arg('--expected-bytes');
  const expectedSha256 = arg('--expected-sha256');
  if (Boolean(expectedBytes) !== Boolean(expectedSha256)) throw new Error('--expected-bytes 与 --expected-sha256 必须成对传入');
  const expectedBackup = expectedBytes ? { bytes: Number(expectedBytes), sha256: expectedSha256 } : undefined;
  if (expectedBackup && (!Number.isSafeInteger(expectedBackup.bytes) || expectedBackup.bytes <= 0 || !/^[a-f0-9]{64}$/.test(expectedBackup.sha256))) {
    throw new Error('已核对备份的大小或 sha256 无效');
  }
  const config = r2BackupConfigFromEnv();
  if (!objectKey) throw new Error('缺少 --object-key');
  if (!mongoImage) throw new Error('缺少 --mongo-image，须与已核对的源库版本一致');
  if (!config) throw new Error('缺少完整 R2 环境配置');

  const budget = (name: string): number | undefined => arg(name) ? Number(arg(name)) : undefined;
  const result = await runMongoR2RecoveryDrill({ config, objectKey, mongoImage,
    maxArchiveBytes: budget('--max-archive-bytes'), dataBytes: budget('--data-bytes'),
    memoryBytes: budget('--memory-bytes'), timeoutMs: budget('--timeout-ms'),
    expectedBackup,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
