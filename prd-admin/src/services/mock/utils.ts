import { fail } from '@/types/api';

export async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

export function randomFail<T>(rate = 0.02) {
  if (Math.random() < rate) {
    return fail('UNKNOWN', 'mock: 随机失败（用于覆盖错误态）') as any as T;
  }
  return null;
}
