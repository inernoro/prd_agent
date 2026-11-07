/** 等待已经受控的应用退出；完成后必须移除不再需要的期限计时器。 */
export async function waitForBootstrapExit<T>(exit: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([exit, new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
