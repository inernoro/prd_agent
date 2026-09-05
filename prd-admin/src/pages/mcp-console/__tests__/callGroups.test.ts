import { describe, expect, it } from 'vitest';
import { groupCalls } from '../callGroups';
import type { McpCallLogDto } from '@/services/contracts/mcpConsole';

function call(over: Partial<McpCallLogDto>): McpCallLogDto {
  return {
    id: Math.random().toString(36).slice(2),
    keyId: 'k1',
    keyName: '书房的 Claude Code',
    toolName: 'map_visual_get_run',
    capability: 'visual',
    status: 'success',
    isWrite: false,
    imageCount: 0,
    deduplicated: false,
    durationMs: 120,
    argumentsPreview: null,
    errorMessage: null,
    artifact: null,
    createdAt: '2026-09-05T10:00:00.000Z',
    ...over,
  };
}

/** 入参是列表接口的顺序：最新在前。 */
function run(kind = 'image-run', id = 'run-1', keyId = 'k1') {
  return {
    poll2: call({
      keyId,
      createdAt: '2026-09-05T10:00:30.000Z',
      artifact: { kind, id, url: 'https://example.com/a.png', title: '一只猫' },
    }),
    poll1: call({ keyId, createdAt: '2026-09-05T10:00:15.000Z', artifact: { kind, id, url: null, title: null } }),
    enqueue: call({
      keyId,
      toolName: 'map_visual_generate',
      isWrite: true,
      imageCount: 2,
      argumentsPreview: 'prompt=一只猫',
      createdAt: '2026-09-05T10:00:00.000Z',
      artifact: { kind, id, url: null, title: null },
    }),
  };
}

describe('把调用流水折成「一件事一行」', () => {
  it('入队与它之后的轮询折成一件事', () => {
    const { poll2, poll1, enqueue } = run();
    const groups = groupCalls([poll2, poll1, enqueue]);

    expect(groups).toHaveLength(1);
    expect(groups[0].steps).toHaveLength(3);
    // 参数摘要在发起那次上，产物地址在最后那次上 —— 两头都要取对
    expect(groups[0].first.argumentsPreview).toBe('prompt=一只猫');
    expect(groups[0].artifact?.url).toBe('https://example.com/a.png');
    expect(groups[0].multiStep).toBe(true);
  });

  it('结局取最后一次，不是「出现过失败就算失败」', () => {
    const { poll2, poll1, enqueue } = run();
    // 中途一次超时，后来成了 —— 这件事就是成了
    const groups = groupCalls([poll2, { ...poll1, status: 'error', errorMessage: '超时' }, enqueue]);
    expect(groups[0].status).toBe('success');
  });

  it('最后一次失败时整件事算失败，原因取那一次的', () => {
    const { poll1, enqueue } = run();
    const failed = call({
      createdAt: '2026-09-05T10:00:40.000Z',
      status: 'error',
      errorMessage: '模型被下架了',
      artifact: { kind: 'image-run', id: 'run-1', url: null, title: null },
    });
    const groups = groupCalls([failed, poll1, enqueue]);
    expect(groups[0].status).toBe('error');
    expect(groups[0].last.errorMessage).toBe('模型被下架了');
  });

  it('两台客户端轮询同一个 run 不许混成一行', () => {
    // 归并键少了 keyId 的话，审计面板会把「谁干的」这件事说错
    const mine = run('image-run', 'run-1', 'k1');
    const theirs = run('image-run', 'run-1', 'k2');
    const groups = groupCalls([mine.poll2, theirs.poll2, mine.enqueue, theirs.enqueue]);
    expect(groups).toHaveLength(2);
  });

  it('没有产物身份的行各自成行', () => {
    // 被挡下、参数错、纯读类工具：一次失败本来就是一件独立的事，折起来会把它藏掉
    const denied = call({ status: 'denied', errorMessage: '每分钟最多 60 次', artifact: null });
    const other = call({ status: 'denied', errorMessage: '每分钟最多 60 次', artifact: null });
    expect(groupCalls([denied, other])).toHaveLength(2);
  });

  it('出图张数取最大不取求和', () => {
    // 同一个 run 被重试时每条都记着「这次要 N 张」，加起来会把一次重试说成出了两倍的图
    const { poll2, enqueue } = run();
    const retry = call({
      toolName: 'map_visual_generate',
      isWrite: true,
      imageCount: 2,
      deduplicated: true,
      createdAt: '2026-09-05T10:00:05.000Z',
      artifact: { kind: 'image-run', id: 'run-1', url: null, title: null },
    });
    expect(groupCalls([poll2, retry, enqueue])[0].imageCount).toBe(2);
  });

  it('多步时给的是墙上时钟，单步时给的是那次调用自己的耗时', () => {
    const { poll2, poll1, enqueue } = run();
    expect(groupCalls([poll2, poll1, enqueue])[0].elapsedMs).toBe(30_000);

    const solo = call({ durationMs: 450, artifact: null });
    expect(groupCalls([solo])[0].elapsedMs).toBe(450);
  });

  it('列表顺序按每件事第一次出现的位置排，最新的事在最前', () => {
    const older = run('image-run', 'run-old');
    const newer = call({ createdAt: '2026-09-05T11:00:00.000Z', artifact: null, toolName: 'map_web_publish_page' });
    const groups = groupCalls([newer, older.poll2, older.enqueue]);
    expect(groups[0].first.toolName).toBe('map_web_publish_page');
    expect(groups[1].steps).toHaveLength(2);
  });
});
