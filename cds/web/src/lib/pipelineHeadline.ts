/**
 * 验收首页的那句判断（2026-09-10）。
 *
 * 为什么单独抽出来：上一版首页是一排计数（改动 5 / 部署 4 / 验收 1 / 合并 0、漏 3、
 * 另有 18 份无从核对），每个数字都对，合起来不告诉读者任何事——用户原话「我看不懂你的首页」。
 * 按 conclusion-before-numbers.md，数据界面有三层：计数 → 对照 → 结论，上一版停在第二层。
 *
 * 所以这里产出**结论层**：一句挂着数字的判断 + 两三条同样挂着数字的支撑 + 一个下一步。
 * 三条自律照抄那份规则：
 *   1. 每句必须挂真实数字，「整体表现良好」这种放到任何团队都成立的话一律不出;
 *   2. 算不出来就不出这句，不为凑版面降低标准;
 *   3. 规则生成而非 LLM 生成——首页要秒开、要可复现、出错能定位到具体分支。
 *
 * 纯函数，不碰 React，好让守卫直接断言句子本身。
 */
import type { PipelineOverview } from './api';

export type HeadlineTone = 'bad' | 'warn' | 'ok';

export interface PipelineHeadline {
  tone: HeadlineTone;
  /** 第一眼那句判断。 */
  sentence: string;
  /** 支撑句，每条都挂着数字；按重要度排，最多三条。 */
  points: string[];
  /** 下一步该动谁；没有明确对象时为 null，绝不写「请关注」这种空话。 */
  action: string | null;
}

/** 漏点最多的那个项目；并列时取改动多的。用来回答「这些集中在谁那里」。 */
function worstProject(p: PipelineOverview): { name: string; leaks: number } | null {
  let best: { name: string; leaks: number; changes: number } | null = null;
  for (const row of p.projects) {
    const leaks = Object.values(row.leaks).reduce((n, v) => n + v, 0);
    if (leaks === 0) continue;
    if (!best || leaks > best.leaks || (leaks === best.leaks && row.funnel.changes > best.changes)) {
      best = { name: row.projectName, leaks, changes: row.funnel.changes };
    }
  }
  return best ? { name: best.name, leaks: best.leaks } : null;
}

/** 取前 N 个某类漏点的主体名，用来把「下一步」指到具体分支上。 */
function subjectsOf(p: PipelineOverview, kind: string, limit: number): string[] {
  return p.leaks.filter((l) => l.kind === kind).slice(0, limit).map((l) => l.subject);
}

export function buildPipelineHeadline(p: PipelineOverview): PipelineHeadline {
  const t = p.total;
  const L = p.totalLeaks;
  const points: string[] = [];

  // 支撑句 1：这些集中在谁那里。只有一个项目时不说——废话。
  const worst = worstProject(p);
  if (worst && p.projects.length > 1) {
    points.push(`最集中的是「${worst.name}」，占 ${worst.leaks} 条`);
  }

  // 支撑句 2：验过的那些，结论如何。全是通过就不单独说，避免凑数。
  if (t.accepted > 0 && (t.fail > 0 || t.conditional > 0)) {
    const parts: string[] = [];
    if (t.fail > 0) parts.push(`未通过 ${t.fail} 条`);
    if (t.conditional > 0) parts.push(`原则性通过 ${t.conditional} 条`);
    points.push(`验过的 ${t.accepted} 条里，${parts.join('、')}`);
  }

  // 支撑句 3：更危险的那一类是不是干净的。说「没有」也是结论，前提是查得到。
  const linked = p.projects.filter((r) => r.githubLinked).length;
  if (linked > 0 && L['merged-not-accepted'] === 0 && L['merged-while-failing'] === 0) {
    points.push('没有「没验就合并」或「没过还合并」的情况');
  }

  // 支撑句 4：查不到的部分要明说，否则上面那句「没有」会被读成保证。
  const unlinked = p.projects.filter((r) => !r.githubLinked).length;
  if (unlinked > 0) {
    points.push(`${unlinked} 个项目没接 GitHub，合并这一步查不到——是看不见，不是没有`);
  }

  const top = (kind: string, n: number): string => {
    const names = subjectsOf(p, kind, n);
    return names.length ? names.join('、') : '';
  };

  // 判断句本身：按严重度取第一条成立的，不叠加。
  if (L['merged-not-accepted'] > 0) {
    const n = L['merged-not-accepted'];
    return {
      tone: 'bad',
      sentence: `${n} 条改动一次验收都没做，已经进了主干`,
      points: points.slice(0, 3),
      action: top('merged-not-accepted', 3) ? `补验：${top('merged-not-accepted', 3)}` : null,
    };
  }
  if (L['merged-while-failing'] > 0) {
    const n = L['merged-while-failing'];
    return {
      tone: 'bad',
      sentence: `${n} 条改动验收没通过，仍然进了主干`,
      points: points.slice(0, 3),
      action: top('merged-while-failing', 3) ? `复查：${top('merged-while-failing', 3)}` : null,
    };
  }
  if (L['deployed-not-accepted'] > 0) {
    const n = L['deployed-not-accepted'];
    return {
      tone: 'warn',
      sentence: `${t.changes} 条在改的分支里，${n} 条部署了但没人验收`,
      points: points.slice(0, 3),
      action: top('deployed-not-accepted', 3) ? `先验：${top('deployed-not-accepted', 3)}` : null,
    };
  }
  if (t.changes === 0) {
    return { tone: 'ok', sentence: '现在没有在改的分支', points: [], action: null };
  }
  if (t.accepted >= t.changes) {
    return {
      tone: 'ok',
      sentence: `${t.changes} 条在改的分支都验过了`,
      points: points.slice(0, 3),
      action: null,
    };
  }
  // 兜底：还有没部署因而谈不上验收的分支。不编判断，如实说构成。
  return {
    tone: 'ok',
    sentence: `${t.changes} 条在改的分支，${t.accepted} 条验过、${t.changes - t.deployed} 条还没部署`,
    points: points.slice(0, 3),
    action: null,
  };
}
