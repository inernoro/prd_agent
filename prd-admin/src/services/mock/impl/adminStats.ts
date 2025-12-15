import { ok, type ApiResponse } from '@/types/api';
import type { ActiveGroup, GapStats, OverviewStats, TokenUsage, TrendItem } from '@/services/contracts/adminStats';
import { sleep } from '@/services/mock/utils';
import { db } from '@/services/mock/db';

export async function getOverviewStatsMock(): Promise<ApiResponse<OverviewStats>> {
  await sleep(280);
  const totalUsers = db.users.length;
  const activeUsers = db.users.filter((u) => u.status === 'Active').length;
  return ok({
    totalUsers,
    activeUsers,
    totalGroups: 23,
    todayMessages: 1842,
  });
}

export async function getTokenUsageMock(days = 7): Promise<ApiResponse<TokenUsage>> {
  await sleep(260);
  const d = Math.max(1, Math.min(30, Math.floor(days || 7)));
  const base = d * 12000;
  const totalInput = base + 18000;
  const totalOutput = Math.floor(base * 0.78);
  return ok({ totalInput, totalOutput, totalTokens: totalInput + totalOutput });
}

export async function getMessageTrendMock(days = 14): Promise<ApiResponse<TrendItem[]>> {
  await sleep(260);
  const d = Math.max(1, Math.min(30, Math.floor(days || 14)));
  const out: TrendItem[] = [];
  for (let i = d - 1; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86400000);
    const date = dt.toISOString().slice(0, 10);
    // 简单制造一点波动
    const count = Math.max(0, Math.floor(120 + Math.sin(i / 2) * 30 + Math.random() * 25));
    out.push({ date, count });
  }
  return ok(out);
}

export async function getActiveGroupsMock(limit = 10): Promise<ApiResponse<ActiveGroup[]>> {
  await sleep(260);
  const n = Math.max(1, Math.min(50, Math.floor(limit || 10)));
  const out: ActiveGroup[] = Array.from({ length: n }).map((_, idx) => ({
    groupId: `g_${idx + 1}`,
    groupName: `群组 ${idx + 1}`,
    memberCount: 3 + ((idx * 7) % 18),
    messageCount: 200 + ((idx * 37) % 900),
    gapCount: idx % 4 === 0 ? 0 : (idx % 6),
  }));
  return ok(out);
}

export async function getGapStatsMock(): Promise<ApiResponse<GapStats>> {
  await sleep(240);
  const pending = 12;
  const resolved = 38;
  const ignored = 7;
  const total = pending + resolved + ignored;
  return ok({
    total,
    byStatus: { pending, resolved, ignored },
    byType: { requirement: 22, ui: 11, api: 15, test: 9 },
  });
}
