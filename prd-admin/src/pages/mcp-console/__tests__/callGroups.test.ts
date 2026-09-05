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

  it('幂等命中的重试折进同一件事，出图张数取最大不取求和', () => {
    // 幂等命中那次什么副作用都没产生，它不是新的一件事；
    // 而每条都记着「这次要 N 张」，加起来会把一次重试说成出了两倍的图
    const { poll2, enqueue } = run();
    const retry = call({
      toolName: 'map_visual_generate',
      isWrite: true,
      imageCount: 2,
      deduplicated: true,
      createdAt: '2026-09-05T10:00:05.000Z',
      artifact: { kind: 'image-run', id: 'run-1', url: null, title: null },
    });
    const groups = groupCalls([poll2, retry, enqueue]);
    expect(groups).toHaveLength(1);
    expect(groups[0].imageCount).toBe(2);
  });

  it('同一篇文档改两次是两件事，不许折成一行', () => {
    // 事故形状：map_kb_update_entry 两次都回同一个 entryId。只按产物身份折的话，
    // 第二次的「成功」会把第一次的失败盖掉，而展示的参数摘要来自那次不相干的旧编辑。
    const entry = { kind: 'entry', id: 'e-1', url: null, title: null };
    const firstEdit = call({
      toolName: 'map_kb_update_entry',
      isWrite: true,
      status: 'error',
      errorMessage: '这篇文档正在被别人改',
      argumentsPreview: 'content=第一稿',
      createdAt: '2026-09-05T10:00:00.000Z',
      artifact: entry,
    });
    const secondEdit = call({
      toolName: 'map_kb_update_entry',
      isWrite: true,
      argumentsPreview: 'content=第二稿',
      createdAt: '2026-09-05T10:05:00.000Z',
      artifact: entry,
    });
    const groups = groupCalls([secondEdit, firstEdit]);
    expect(groups).toHaveLength(2);
    expect(groups[0].status).toBe('success');
    expect(groups[1].status).toBe('error');
    expect(groups[1].first.argumentsPreview).toBe('content=第一稿');
  });

  it('写入之后的读取折进那次写入，下一次写入另起一件', () => {
    const art = { kind: 'workspace', id: 'w-1', url: null, title: null };
    const write1 = call({ isWrite: true, argumentsPreview: '第一段', createdAt: '2026-09-05T10:00:00.000Z', artifact: art });
    const read1 = call({ isWrite: false, createdAt: '2026-09-05T10:00:10.000Z', artifact: art });
    const write2 = call({ isWrite: true, argumentsPreview: '第二段', createdAt: '2026-09-05T10:01:00.000Z', artifact: art });
    const read2 = call({ isWrite: false, createdAt: '2026-09-05T10:01:10.000Z', artifact: art });

    const groups = groupCalls([read2, write2, read1, write1]);
    expect(groups).toHaveLength(2);
    expect(groups[0].first.argumentsPreview).toBe('第二段');
    expect(groups[1].first.argumentsPreview).toBe('第一段');
    expect(groups.every((g) => g.steps.length === 2)).toBe(true);
  });

  it('入队落在上一页时，剩下的轮询仍折成一行，但标明「没有发起」', () => {
    // 它们确实是同一件事，该折；但这一行的第一步是一次查看，不是动作 ——
    // 不标出来的话，详情里那句「从发起到落地 Xs」是在编一个没看见的时刻
    const art = { kind: 'image-run', id: 'run-x', url: null, title: null };
    const readA = call({ isWrite: false, createdAt: '2026-09-05T10:00:10.000Z', artifact: art });
    const readB = call({ isWrite: false, createdAt: '2026-09-05T10:00:20.000Z', artifact: art });
    const groups = groupCalls([readB, readA]);
    expect(groups).toHaveLength(1);
    expect(groups[0].hasOrigin).toBe(false);
  });

  it('入队开头的那件事标成「有发起」', () => {
    const { poll2, poll1, enqueue } = run();
    expect(groupCalls([poll2, poll1, enqueue])[0].hasOrigin).toBe(true);
  });

  it('以查看收尾又没有产物：如实说「还没出结果」，不打绿色成功', () => {
    // 网关的 log.Status 是纯按 HTTP 判的：生图 run 还在排队、甚至已经失败，
    // map_visual_get_run 照样回 200 → 这几步全是 success。照搬最后一步就是给失败的 run 打绿灯。
    const art = { kind: 'image-run', id: 'run-p', url: null, title: null };
    const enqueue = call({ isWrite: true, imageCount: 1, createdAt: '2026-09-05T10:00:00.000Z', artifact: art });
    const poll = call({ isWrite: false, createdAt: '2026-09-05T10:00:20.000Z', artifact: art });
    expect(groupCalls([poll, enqueue])[0].status).toBe('pending');
  });

  it('产物地址出来了才算成', () => {
    const { poll2, poll1, enqueue } = run();   // poll2 带 url
    expect(groupCalls([poll2, poll1, enqueue])[0].status).toBe('success');
  });

  it('以写入收尾的事件，HTTP 结果就是结局', () => {
    // 写入不一样：它的 200 就代表那件事做完了，不需要再等产物
    const art = { kind: 'entry', id: 'e-9', url: null, title: null };
    const write = call({ isWrite: true, createdAt: '2026-09-05T10:00:00.000Z', artifact: art });
    expect(groupCalls([write])[0].status).toBe('success');
  });

  it('最后一次真的失败时照样是失败，不被改写成「还没出结果」', () => {
    const art = { kind: 'image-run', id: 'run-f', url: null, title: null };
    const enqueue = call({ isWrite: true, createdAt: '2026-09-05T10:00:00.000Z', artifact: art });
    const failed = call({ isWrite: false, status: 'error', errorMessage: '模型被下架了', createdAt: '2026-09-05T10:00:20.000Z', artifact: art });
    expect(groupCalls([failed, enqueue])[0].status).toBe('error');
  });

  it('多步时给的是墙上时钟，单步时给的是那次调用自己的耗时', () => {
    const { poll2, poll1, enqueue } = run();
    expect(groupCalls([poll2, poll1, enqueue])[0].elapsedMs).toBe(30_000);

    const solo = call({ durationMs: 450, artifact: null });
    expect(groupCalls([solo])[0].elapsedMs).toBe(450);
  });

  it('列表按每件事的最后一步时间倒序，最新的事在最前', () => {
    const older = run('image-run', 'run-old');
    const newer = call({ createdAt: '2026-09-05T11:00:00.000Z', artifact: null, toolName: 'map_web_publish_page' });
    const groups = groupCalls([newer, older.poll2, older.enqueue]);
    expect(groups[0].first.toolName).toBe('map_web_publish_page');
    expect(groups[1].steps).toHaveLength(2);
  });
});
