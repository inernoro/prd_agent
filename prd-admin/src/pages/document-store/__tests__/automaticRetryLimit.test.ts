/**
 * 跨语言 SSOT 守卫：前端那句「第 2 / 3 次」的分母，必须等于后端真正的重试预算。
 *
 * 接口里不下发这个数，前端只能存一份副本。副本会漂——所以这条测试直接去读
 * 后端那个常量，两边对不上就红（predicate-and-wiring-discipline 形状 3）。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTOMATIC_RETRY_LIMIT } from '../recordingVault';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.resolve(
  HERE, '..', '..', '..', '..', '..',
  'prd-api/src/PrdAgent.Api/Services/DocumentRecordingArchiveWorker.cs',
);

describe('自动重试预算的前后端一致', () => {
  it('前端常量等于后端 MaxDeferredTranscriptionAutomaticRetries', () => {
    expect(fs.existsSync(WORKER), `找不到后端 Worker：${WORKER}`).toBe(true);
    const source = fs.readFileSync(WORKER, 'utf8');
    const matched = /MaxDeferredTranscriptionAutomaticRetries\s*=\s*(\d+)\s*;/.exec(source);
    expect(matched, '后端那个常量的写法变了，守卫读不到——先改这条正则').not.toBeNull();
    expect(AUTOMATIC_RETRY_LIMIT).toBe(Number(matched![1]));
  });
});
