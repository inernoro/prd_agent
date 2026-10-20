import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { timeMainThreadSection } from './main-thread-diagnostics.js';

/** 保持原v1文件；逐目标序列化，异步写盘，避免整份历史同步复制和拼接。 */
export async function writeUptimeHistory(
  target: string, savedAt: number, records: ReadonlyArray<unknown>,
): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let owned = false, committed = false;
  try {
    handle = await fs.open(tmp, 'wx', 0o600); owned = true;
    await handle.writeFile(`{"version":1,"savedAt":${JSON.stringify(savedAt)},"targets":[`);
    let index = 0;
    while (index < records.length) {
      const chunk = timeMainThreadSection('uptime.persist', () => {
        const started = performance.now();
        const parts: string[] = [];
        let chars = 0;
        // 单个目标仍同步序列化；不能把8ms视作单目标的硬期限。
        while (index < records.length && parts.length < 16) {
          const part = `${index ? ',' : ''}${JSON.stringify(records[index++])}`;
          parts.push(part); chars += part.length;
          if (performance.now() - started >= 8 || chars >= 256 * 1024) break;
        }
        return parts.join('');
      }, json => json.length);
      await handle.writeFile(chunk);
      await yieldToLoop();
    }
    await handle.writeFile(']}');
    await handle.sync();
    await handle.close(); handle = undefined;
    await fs.rename(tmp, target); committed = true;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (owned && !committed) await fs.unlink(tmp).catch(() => {});
  }
}
