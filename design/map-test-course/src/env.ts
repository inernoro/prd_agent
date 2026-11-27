/* 原型运行环境（只用于原型，不进源码差异）。
 * CDS 预览容器是不透明源：访问 localStorage / sessionStorage 会抛错、不能发网络请求。
 * 这里先装内存存储，再把 fetch 换成模拟服务端（课程进度、练习 Run 按时间推进、判定在「服务端」完成）。 */
import type { AgentRun, Course, Decision, PracticeRun, RetestResult } from '@/pages/learning-course/types';
import { COURSE_ID, initialCourse, practiceFindings, practices, retestChecks, runStages, summaryOf } from './fixtures';

class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
for (const k of ['localStorage', 'sessionStorage']) {
  try { Object.defineProperty(window, k, { value: new MemStorage(), configurable: true }); } catch { /* 已可用 */ }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (data: unknown) => json({ success: true, data, error: null });
const fail = (message: string, code = 'NOT_FOUND') => json({ success: false, data: null, error: { code, message } });

/* 演示时间压缩：原型里 1 秒按真实 8 秒显示 */
const SCALE = 8;
const MODEL = { model: 'anthropic/claude-sonnet-4.5', platform: 'OpenRouter' };
const clock = () => new Date().toTimeString().slice(0, 5);

const course: Course = initialCourse();

type State = {
  id: string; practiceId: string; attempt: number;
  phase: 'brief' | 'review' | 'review-failed' | 'triage' | 'retest' | 'deliver' | 'done';
  startedAt: number; frozenAt?: number;
  decisions: Record<string, Decision>; reasons: Record<string, string>;
  retest?: RetestResult; note?: string; submittedAt?: string; timeline: { at: string; text: string }[];
};
const runs = new Map<string, State>();
let seq = 0;

function evaluate(s: State): RetestResult {
  const all = practiceFindings[s.practiceId];
  const wrong = new Map<string, string>();
  for (const f of all) {
    const d = s.decisions[f.id];
    if (f.truth.decision === 'either') continue;
    if (d !== f.truth.decision) wrong.set(f.id, (d === 'accept' ? f.truth.wrongAccept : f.truth.wrongReject) ?? '这条判断和复测结果不一致。');
  }
  const checks = retestChecks[s.practiceId].map(c => {
    const bad = c.dependsOn.find(id => wrong.has(id));
    return bad ? { name: c.name, status: 'fail' as const, message: '失败' } : { name: c.name, status: 'pass' as const, message: c.okMessage };
  });
  const passed = wrong.size === 0;
  return {
    passed, checks,
    feedback: [...wrong].map(([findingId, message]) => ({ findingId, message })),
    summary: passed ? '所有检查通过，修复只覆盖了被证实的问题。' : `${wrong.size} 条判断和复测结果不一致，对应的检查没有通过。`,
  };
}

function stagesAt(defs: [string, string, number][], t: number, failAt?: number) {
  let acc = 0;
  const total = defs.reduce((s, d) => s + d[2], 0);
  const stages = defs.map(([key, label, dur], i) => {
    const start = acc; acc += dur;
    if (failAt != null && i === failAt) return { key, label, status: 'failed' as const, detail: '上游模型 30 秒没有响应' };
    if (failAt != null && i > failAt) return { key, label, status: 'waiting' as const };
    return { key, label, status: t >= acc ? 'done' as const : t >= start ? 'running' as const : 'waiting' as const };
  });
  return { stages, total, progress: Math.min(99, Math.round((t / total) * 100)) };
}

function view(s: State): PracticeRun {
  const now = s.frozenAt ?? (Date.now() - s.startedAt) / 1000;
  const defs = runStages[s.practiceId];
  const all = practiceFindings[s.practiceId];
  const strip = ({ truth: _t, appearAt: _a, ...f }: (typeof all)[number]) => f;
  const base: PracticeRun = { id: s.id, practiceId: s.practiceId, step: 'brief', attempt: s.attempt, findings: [], decisions: s.decisions, reasons: s.reasons };

  if (s.phase === 'review' || s.phase === 'review-failed') {
    const failed = s.phase === 'review-failed';
    const { stages, total, progress } = stagesAt(defs.review, failed ? 4.2 : now, failed ? 1 : undefined);
    if (!failed && now >= total) { s.phase = 'triage'; return view(s); }
    const run: AgentRun = {
      id: `${s.id}-review`, purpose: 'review', status: failed ? 'failed' : 'running', stages, progress,
      elapsedSec: Math.round((failed ? 4.2 : now) * SCALE), remainSec: failed ? undefined : Math.max(5, Math.round((total - now) * SCALE)),
      estimateBasis: '最近 30 次同类练习的中位数', model: MODEL,
      failure: failed ? { message: '评审 Agent 这次没有在时限内返回（上游模型 30 秒无响应）。已保存这次练习，重新评审会从头开始，不会重复计费。', retryable: true } : undefined,
    };
    return { ...base, step: 'review', run, findings: all.filter(f => f.appearAt <= (failed ? 3.3 : now)).map(strip) };
  }
  if (s.phase === 'triage') return { ...base, step: 'triage', findings: all.map(strip), retest: s.retest };
  if (s.phase === 'retest') {
    const { stages, total, progress } = stagesAt(defs.retest, now);
    const done = now >= total;
    if (done && !s.retest) s.retest = evaluate(s);
    if (done && s.retest?.passed) { s.phase = 'deliver'; s.timeline.push({ at: clock(), text: '复测全部通过' }); return view(s); }
    const run: AgentRun = {
      id: `${s.id}-retest`, purpose: 'retest', status: done ? 'done' : 'running',
      stages: done ? stages.map(x => ({ ...x, status: 'done' as const })) : stages, progress: done ? 100 : progress,
      elapsedSec: Math.round(now * SCALE), remainSec: done ? undefined : Math.max(5, Math.round((total - now) * SCALE)),
      estimateBasis: '本练习复测的固定用例耗时', model: MODEL,
    };
    return { ...base, step: 'retest', run, findings: all.map(strip), retest: done ? s.retest : undefined };
  }
  const draft = deliveryDraft(s);
  if (s.phase === 'deliver') return { ...base, step: 'deliver', findings: all.map(strip), retest: s.retest, deliveryDraft: draft, delivery: s.note ? { note: s.note } : undefined };
  if (s.phase === 'done') return { ...base, step: 'done', findings: all.map(strip), retest: s.retest, delivery: { note: s.note ?? draft, submittedAt: s.submittedAt }, outcome: { xp: 40, timeline: s.timeline } };
  return base;
}

function deliveryDraft(s: State): string {
  const all = practiceFindings[s.practiceId];
  const p = practices[s.practiceId];
  const accepted = all.filter(f => s.decisions[f.id] === 'accept');
  const rejected = all.filter(f => s.decisions[f.id] === 'reject');
  const checks = (s.retest?.checks ?? []).map(c => `  - ${c.name}${c.message ? `（${c.message}）` : ''}`).join('\n');
  return [
    `能做什么：${p.acceptance.join('；')}。`,
    `  采纳 ${accepted.length} 处：${accepted.map(f => f.title).join('；') || '无'}`,
    `怎么证明：复测通过 ${s.retest?.checks.length ?? 0} 项`,
    checks,
    `还没做到什么：`,
    ...rejected.map(f => `  - 未处理「${f.title}」：${s.reasons[f.id] || '已驳回'}`),
    rejected.length ? '' : '  - 无',
  ].filter(x => x !== '').join('\n');
}

function syncPractice(practiceId: string, status: 'doing' | 'done', runId: string) {
  course.practices = course.practices.map(p => (p.id === practiceId ? { ...p, status: p.status === 'done' ? 'done' : status, runId: status === 'done' ? undefined : runId } : p));
}

/* 画面清单用的固定状态（冻结在某一刻，便于截图核对）；用户在其上操作后按真实流程推进 */
function seed(id: string, practiceId: string, phase: State['phase'], patch: Partial<State> = {}) {
  runs.set(id, { id, practiceId, attempt: 1, phase, startedAt: Date.now(), decisions: {}, reasons: {}, timeline: [{ at: '14:02', text: 'Agent 开始检查' }], ...patch });
}
seed('run-reviewing', 'p-review', 'review', { frozenAt: 5.1 });
seed('run-review-failed', 'p-review', 'review-failed');
seed('run-triage', 'p-review', 'triage', { decisions: { R1: 'accept' }, reasons: {} });
seed('run-retest-failed', 'p-review', 'retest', { frozenAt: 99, decisions: { R1: 'accept', R2: 'accept', R3: 'accept', R4: 'reject' }, reasons: { R4: '属于风格偏好，不影响结果' } });
seed('run-deliver', 'p-review', 'deliver', { decisions: { R1: 'accept', R2: 'accept', R3: 'reject', R4: 'reject' }, reasons: { R3: '前提不成立：函数没有共享状态', R4: '属于风格偏好，不影响结果' } });
seed('run-done', 'p-review', 'done', { decisions: { R1: 'accept', R2: 'accept', R3: 'reject', R4: 'reject' }, reasons: { R3: '前提不成立：函数没有共享状态', R4: '属于风格偏好，不影响结果' }, submittedAt: '14:11',
  timeline: [{ at: '14:02', text: 'Agent 开始评审' }, { at: '14:03', text: '报告 4 处意见' }, { at: '14:06', text: '采纳 2 处、驳回 2 处' }, { at: '14:07', text: '第 1 次复测未通过：误采纳了加锁建议' }, { at: '14:09', text: '改判后复测全部通过' }, { at: '14:11', text: '提交交付说明' }] });
seed('run-visual-triage', 'p-visual', 'triage');
seed('run-unit-triage', 'p-unit', 'triage', { decisions: { U1: 'accept', U2: 'accept' } });
for (const s of runs.values()) if (s.phase === 'retest' || s.phase === 'deliver' || s.phase === 'done') { s.retest = evaluate(s); if (s.phase === 'retest') s.startedAt = Date.now() - 99000; }
const deliverSeed = runs.get('run-deliver')!; deliverSeed.retest = evaluate(deliverSeed);

/* 学习中心原有的短教程进度（与服务端 /api/daily-tips/progress 同形） */
const tutorialProgress = {
  total: 6, learned: 2, xp: 120, level: 2, levelName: '熟手', xpToNext: 80, levelFloorXp: 100, nextLevelXp: 200,
  items: [
    { tipId: 't1', sourceId: 'webpages-page-guide', title: '网页托管：发布一个页面', body: '上传、预览、分享三步走完', category: 'onboarding', steps: 14, learned: true, xpReward: 20, difficulty: 'basic', actionUrl: '/web-pages', version: 1 },
    { tipId: 't2', sourceId: 'defect-page-guide', title: '缺陷管理：提交第一条缺陷', body: '浏览 → 打开提交面板 → 填写 → 提交', category: 'onboarding', steps: 8, learned: true, xpReward: 20, difficulty: 'basic', actionUrl: '/defect-agent', version: 1 },
    { tipId: 't3', sourceId: 'pr-review-page-guide', title: 'PR 审查：看懂一份审查报告', body: '四步看完结论、证据和建议', category: 'onboarding', steps: 4, learned: false, xpReward: 20, difficulty: 'basic', actionUrl: '/pr-review', version: 1 },
    { tipId: 't4', sourceId: 'workflow-page-guide', title: '工作流：串起两个智能体', body: '拖入胶囊、连线、试运行', category: 'onboarding', steps: 4, learned: false, xpReward: 30, difficulty: 'advanced', actionUrl: '/workflow-agent', version: 1 },
  ],
};

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://proto.local');
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = url.pathname;
  const body = typeof init?.body === 'string' ? JSON.parse(init.body || '{}') : {};
  await new Promise(r => setTimeout(r, 90));

  if (/user-preferences\/?$/.test(path)) return ok({ navOrder: [], navHidden: [], defaultNavOrder: [], defaultNavHidden: [] });
  if (path.endsWith('/daily-tips/progress')) return ok(tutorialProgress);
  if (path.endsWith('/daily-tips/visible')) return ok({ items: [] });
  if (!path.startsWith('/api/learning')) return ok(null);

  if (path === '/api/learning/courses') return ok({ items: [summaryOf(course)] });
  const progress = path.match(/^\/api\/learning\/courses\/([^/]+)\/lessons\/([^/]+)\/progress$/);
  if (progress && method === 'PUT') {
    const lesson = course.lessons.find(l => l.id === progress[2]);
    if (!lesson) return fail('没有找到这一课');
    if (body.media === 'video' && lesson.media.video && typeof body.positionSec === 'number') lesson.media.video.resumeAtSec = body.positionSec;
    if (body.media === 'pdf' && lesson.media.pdf && body.page) lesson.media.pdf.lastPage = body.page;
    if (body.completed) {
      lesson.status = 'done';
      const next = course.lessons.find(l => l.status === 'todo');
      if (next && !course.lessons.some(l => l.status === 'current')) next.status = 'current';
    }
    return ok({ status: lesson.status === 'done' ? 'done' : 'current' });
  }
  const practice = path.match(/^\/api\/learning\/courses\/([^/]+)\/practices\/([^/]+)$/);
  if (practice) return practices[practice[2]] ? ok(practices[practice[2]]) : fail('没有找到这个练习');
  const courseMatch = path.match(/^\/api\/learning\/courses\/([^/]+)$/);
  if (courseMatch) return courseMatch[1] === COURSE_ID ? ok(course) : fail('没有找到这门课程');

  if (path === '/api/learning/practice-runs' && method === 'POST') {
    if (!practices[body.practiceId]) return fail('没有找到这个练习');
    seq += 1;
    const id = `run-live-${seq}`;
    runs.set(id, { id, practiceId: body.practiceId, attempt: 1, phase: 'review', startedAt: Date.now(), decisions: {}, reasons: {}, timeline: [{ at: clock(), text: 'Agent 开始检查' }] });
    syncPractice(body.practiceId, 'doing', id);
    return ok(view(runs.get(id)!));
  }
  const action = path.match(/^\/api\/learning\/practice-runs\/([^/]+)(?:\/(review|decisions|reopen|delivery))?$/);
  if (!action) return ok(null);
  const s = runs.get(action[1]);
  if (!s) return fail('没有找到这次练习，可能已被重置');
  const verb = action[2];
  if (!verb) return ok(view(s));
  if (verb === 'review') { Object.assign(s, { phase: 'review', startedAt: Date.now(), frozenAt: undefined }); return ok(view(s)); }
  if (verb === 'decisions') {
    const all = practiceFindings[s.practiceId];
    if (all.some(f => !body.decisions?.[f.id])) return fail('还有意见没有判断', 'INVALID_FORMAT');
    Object.assign(s, { decisions: body.decisions, reasons: body.reasons ?? {}, phase: 'retest', startedAt: Date.now(), frozenAt: undefined, retest: undefined });
    const acc = Object.values(s.decisions).filter(d => d === 'accept').length;
    s.timeline.push({ at: clock(), text: `采纳 ${acc} 处、驳回 ${all.length - acc} 处，开始复测` });
    return ok(view(s));
  }
  if (verb === 'reopen') {
    s.timeline.push({ at: clock(), text: `第 ${s.attempt} 次复测未通过，回到判断` });
    Object.assign(s, { phase: 'triage', attempt: s.attempt + 1, frozenAt: undefined });
    return ok(view(s));
  }
  if (verb === 'delivery') {
    Object.assign(s, { note: String(body.note ?? ''), phase: 'done', submittedAt: clock() });
    s.timeline.push({ at: clock(), text: '提交交付说明' });
    syncPractice(s.practiceId, 'done', s.id);
    return ok(view(s));
  }
  return ok(null);
};

try { Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true }); } catch { /* 忽略 */ }
export {};
