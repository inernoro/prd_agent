import { readFile } from 'node:fs/promises';

/** echo重定向先创建空文件；完整数字行才说明PID写入已结束，不能拿PID=0检查整个测试组。 */
export async function readReadyFixturePid(file: string): Promise<number | undefined> {
  let raw: string;
  try { raw = await readFile(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const match = /^([1-9]\d*)\r?\n$/.exec(raw);
  const pid = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}
