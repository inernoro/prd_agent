import { expect, it, vi } from 'vitest';
import { connectSse } from '@/lib/useSseStream';
import { streamQuickCreationBrief } from './quickCreation';

vi.mock('@/lib/useSseStream', () => ({
  connectSse: vi.fn().mockResolvedValue({ success: true }),
}));

it('retries a conversation turn with a new transport intent and the same logical turn', async () => {
  const turn = {
    turnId: '278f312648dd4d30b97d1e778bd522af',
    mode: 'message' as const,
    text: '先说说这次想做的内容',
    context: { revision: 2, kind: 'web' as const, templateId: 'sketchnote', stylePicked: false, attachmentIds: [] },
  };
  const briefId = 'da2393fa4ffd429ebdc09e93d3478014';
  const signal = new AbortController().signal;
  await streamQuickCreationBrief(briefId, turn, signal, vi.fn());
  await streamQuickCreationBrief(briefId, turn, signal, vi.fn());

  const [first, second] = vi.mocked(connectSse).mock.calls.map(([options]) => options);
  expect(first.body).toEqual(turn);
  expect(second.body).toEqual(turn);
  expect(first.url).toBe(second.url);
  expect(first.headers?.['Idempotency-Key']).toBeTruthy();
  expect(second.headers?.['Idempotency-Key']).toBeTruthy();
  expect(first.headers?.['Idempotency-Key']).not.toBe(second.headers?.['Idempotency-Key']);
});
