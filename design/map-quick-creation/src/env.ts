/* 原型运行环境（只用于原型，不进源码差异）。
 * CDS 预览容器是不透明源：访问 localStorage / sessionStorage 会抛错、不能发网络请求。
 * 这里先装内存存储，再把 fetch 换成演示数据路由，然后才加载正式代码。 */
import type { QcAttachment, QcRun, QcScene } from '@/pages/quick-creation-agent/types';
/* 演示成片：由 tools/make-demo-film.mjs 用模板画面渲染、带示意音轨的 WebM，构建时内嵌为 data: 地址 */
import filmUrl from './assets/demo-film.webm';
import { attachmentQueue, fixedRuns, sampleDoc, scenes, stagesAt, templateCategories, templateSource, templates, webKeyPoints, webSections, works } from './fixtures';

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
const fail = (message: string, code = 'UPSTREAM_UNAVAILABLE') => json({ success: false, data: null, error: { code, message } });

/* ---------- 运行中的任务：按提交后的秒数推进 ---------- */
type Live = { kind: 'video' | 'web'; startedAt: number; title: string; templateId: string; ask: string; attachments: QcAttachment[]; fromStage?: number };
const live = new Map<string, Live>();
const publishTries = new Map<string, number>();
/* 恢复：只重做没完成的部分。keep 是保留下来的幕（索引 → 状态），重做的幕按时间推进 */
type Recovery = { kind: 'scene' | 'requeue' | 'step'; startedAt: number; base: QcRun; keep: Map<number, QcScene['status']>; redo: number[] };
const recovering = new Map<string, Recovery>();
const createdAttachments = new Map<string, QcAttachment>();
const publishedAt = new Map<string, string>();

/* 视频：排队 0–8 秒 → 分镜 8–16 → 配音 16–26 → 合成 26–31 → 已生成 */
const VIDEO_STEPS = [8, 16, 26, 31];
const WEB_STEPS = [6, 11, 16, 22];

function liveRun(id: string, l: Live): QcRun {
  const t = (Date.now() - l.startedAt) / 1000;
  const steps = l.kind === 'video' ? VIDEO_STEPS : WEB_STEPS;
  let stage = steps.findIndex(s => t < s);
  if (stage < 0) stage = 4;
  if (l.fromStage != null) stage = Math.max(stage, l.fromStage);
  const prev = stage === 0 ? 0 : steps[stage - 1];
  const span = stage < 4 ? steps[stage] - prev : 1;
  const progress = stage < 4 ? Math.min(96, Math.round(((t - prev) / span) * 100)) : undefined;
  const total = steps[3];
  const status = stage === 0 ? 'queued' : stage < 4 ? 'running' : 'done';
  const base: QcRun = {
    id, title: l.title, kind: l.kind, templateId: l.templateId, ask: l.ask, attachments: l.attachments, status,
    stages: stagesAt(l.kind, stage, { progress }), elapsedSec: Math.round(t * 6), remainSec: status === 'done' ? undefined : Math.max(5, Math.round((total - t) * 6)),
    estimateBasis: '最近 20 次同模板任务的中位数', publish: { status: 'none' }, createdAt: '刚刚', updatedAt: '刚刚',
    queue: stage === 0 ? { position: Math.max(1, 3 - Math.floor(t / 3)), ahead: Math.max(0, 2 - Math.floor(t / 3)), running: 4, capacity: 4, startInSec: Math.max(5, Math.round((8 - t) * 6)) } : undefined,
  };
  if (l.kind === 'video') {
    const drawn = stage < 1 ? 0 : stage === 1 ? Math.min(6, 1 + Math.floor(((t - steps[0]) / (steps[1] - steps[0])) * 6)) : 6;
    const voiced = stage < 2 ? 0 : stage === 2 ? Math.min(6, Math.floor(((t - steps[1]) / (steps[2] - steps[1])) * 6)) : 6;
    return { ...base, voice: '女声 · 稍快', durationSec: 96, keyPoints: fixedRuns['run-done'].keyPoints,
      scenes: scenes(i => (i < voiced ? 'ready' : stage === 2 && i === voiced ? 'voicing' : i < drawn ? (stage === 1 && i === drawn - 1 ? 'drawing' : 'drawn') : 'waiting')) };
  }
  return { ...base, sections: stage >= 1 ? webSections : [], keyPoints: webKeyPoints };
}

function withPublish(run: QcRun): QcRun {
  const at = publishedAt.get(run.id);
  const withMedia = run.kind === 'video' && run.status === 'done' ? { ...run, media: { url: filmUrl, mime: 'video/webm' } } : run;
  return at ? { ...withMedia, publish: { status: 'done', siteId: `site-${run.id}`, siteTitle: run.title, at } } : withMedia;
}

/* 恢复中的任务（演示时间压缩）：单幕重做约 1.6 秒；超时后重新排队约 2 秒，再从未画完的幕继续 */
function recoveryRun(rec: Recovery): QcRun {
  const t = (Date.now() - rec.startedAt) / 1000;
  const { base, keep, redo } = rec;
  const sceneOf = (status: (i: number) => QcScene['status']) => (base.scenes ?? []).map((sc, i) => ({ ...sc, status: keep.has(i) ? keep.get(i)! : status(i) }));
  const common = { failure: undefined, elapsedSec: base.elapsedSec + Math.round(t * 6), estimateBasis: '只重做没完成的部分', publish: base.publish };
  if (rec.kind === 'scene') {
    if (t < 0.8) return { ...base, ...common, status: 'running', stages: stagesAt('video', 2, { progress: Math.round((t / 0.8) * 100) }), remainSec: Math.round((1.6 - t) * 6), scenes: sceneOf(() => 'voicing') };
    if (t < 1.6) return { ...base, ...common, status: 'running', stages: stagesAt('video', 3, { progress: Math.round(((t - 0.8) / 0.8) * 100) }), remainSec: Math.round((1.6 - t) * 6), scenes: sceneOf(() => 'ready').map(sc => ({ ...sc, status: 'ready' })) };
    return { ...base, ...common, status: 'done', stages: stagesAt('video', 4), remainSec: undefined, durationSec: 96, scenes: sceneOf(() => 'ready').map(sc => ({ ...sc, status: 'ready' })) };
  }
  const q = rec.kind === 'requeue' ? 2 : 0;
  if (t < q) return { ...base, ...common, status: 'queued', queue: { position: 2, ahead: 1, running: 4, capacity: 4, startInSec: Math.round((q - t) * 6) }, stages: stagesAt('video', 0), remainSec: 90, scenes: sceneOf(() => 'waiting') };
  const u = t - q;
  if (u < 4) {
    const drawnNow = Math.floor((u / 4) * redo.length);
    return { ...base, ...common, status: 'running', stages: stagesAt('video', 1, { progress: Math.round((u / 4) * 100) }), remainSec: Math.round((11 - u) * 6),
      scenes: sceneOf(i => { const k = redo.indexOf(i); return k < drawnNow ? 'drawn' : k === drawnNow ? 'drawing' : 'waiting'; }) };
  }
  if (u < 8) {
    const voiced = Math.floor(((u - 4) / 4) * 6);
    return { ...base, ...common, status: 'running', stages: stagesAt('video', 2, { progress: Math.round(((u - 4) / 4) * 100) }), remainSec: Math.round((11 - u) * 6),
      scenes: (base.scenes ?? []).map((sc, i) => ({ ...sc, status: i < voiced ? 'ready' : i === voiced ? 'voicing' : 'drawn' })) };
  }
  const done = u >= 11;
  return { ...base, ...common, status: done ? 'done' : 'running', stages: stagesAt('video', done ? 4 : 3, { progress: Math.round(((u - 8) / 3) * 100) }), remainSec: done ? undefined : Math.round((11 - u) * 6), durationSec: 96,
    scenes: (base.scenes ?? []).map(sc => ({ ...sc, status: 'ready' })) };
}

function getRun(id: string): QcRun | undefined {
  const rec = recovering.get(id);
  if (rec) return withPublish(recoveryRun(rec));
  const l = live.get(id);
  if (l) return withPublish(liveRun(id, l));
  const f = fixedRuns[id];
  return f ? withPublish(f) : undefined;
}

let kbCursor = 0;
let seq = 0;

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://proto.local');
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = url.pathname;
  const body = typeof init?.body === 'string' ? JSON.parse(init.body || '{}') : {};
  await new Promise(r => setTimeout(r, 80));

  /* 外壳自身的接口：给出与服务端同形的空数据 */
  if (/user-preferences\/?$/.test(path)) return ok({ navOrder: [], navHidden: [], defaultNavOrder: [], defaultNavHidden: [] });
  if (!path.startsWith('/api/quick-creation')) return ok(null);
  if (path.endsWith('/templates')) return ok({ items: templates, categories: templateCategories, source: templateSource });
  if (path.endsWith('/works')) {
    const mine = [...live.entries()].reverse().map(([id, l]) => {
      const r = getRun(id)!;
      return { runId: id, title: l.title, kind: l.kind, templateId: l.templateId, status: r.status, publishStatus: r.publish.status, summary: r.status === 'done' ? '刚刚完成' : r.stages.find(s => s.status === 'running')?.label ?? '排队中', updatedAt: '刚刚' };
    });
    return ok({ items: [...mine, ...works], total: mine.length + works.length });
  }
  if (path.endsWith('/attachments/knowledge')) {
    if (body.entryId === 'sample-review-habits') return ok(sampleDoc);
    const next = attachmentQueue[kbCursor % attachmentQueue.length];
    kbCursor += 1;
    return ok(next);
  }
  if (path.endsWith('/attachments/text') && method === 'POST') {
    seq += 1;
    const text = String(body.text ?? '');
    const item: QcAttachment = { id: `att-text-${seq}`, kind: 'doc', name: String(body.name || '粘贴的正文.md'), meta: `粘贴的正文 · ${text.length.toLocaleString('zh-CN')} 字`, status: 'ready', chars: text.length, excerpt: text.slice(0, 4000) };
    createdAttachments.set(item.id, item);
    return ok(item);
  }
  const reread = path.match(/\/attachments\/([^/]+)\/read$/);
  if (reread) {
    const item = attachmentQueue.find(a => a.id === reread[1]);
    return item ? ok({ ...item, status: 'ready', chars: 1120, error: undefined, excerpt: '评审会议纪要：目标与边界已确认，验收标准待补。' }) : fail('没有找到这个附件', 'NOT_FOUND');
  }
  if (path.endsWith('/attachments') && method === 'POST') {
    seq += 1;
    const file = init?.body instanceof FormData ? init.body.get('file') : null;
    if (!(file instanceof File)) return fail('没有收到文件，请重新选择', 'INVALID_FORMAT');
    const isImage = file.type.startsWith('image/');
    const isText = /\.(md|markdown|txt)$/i.test(file.name) || file.type.startsWith('text/');
    if (!isImage && !isText) return fail('只支持 Markdown、TXT 稿件和图片', 'INVALID_FORMAT');
    const text = isText ? await file.text() : '';
    const size = file.size < 1024 ? `${file.size} B` : `${(file.size / 1024).toFixed(1)} KB`;
    const item: QcAttachment = isImage
      ? { id: `att-upload-${seq}`, kind: 'image', name: file.name, meta: `图片 · ${size}`, status: 'ready', note: '作为画面参考，不读入旁白' }
      : text.trim()
        ? { id: `att-upload-${seq}`, kind: 'doc', name: file.name, meta: `${/\.txt$/i.test(file.name) ? 'TXT' : 'Markdown'} · ${size}`, status: 'ready', chars: text.length, excerpt: text.slice(0, 4000) }
        : { id: `att-upload-${seq}`, kind: 'doc', name: file.name, meta: size, status: 'failed', error: '没读出文字：文件是空的。请换一个文件。' };
    createdAttachments.set(item.id, item);
    return ok(item);
  }
  if (path.endsWith('/runs') && method === 'POST') {
    seq += 1;
    const id = `run-live-${seq}`;
    const atts = [sampleDoc, ...attachmentQueue, ...createdAttachments.values()].filter(a => (body.attachmentIds ?? []).includes(a.id));
    live.set(id, { kind: body.kind, startedAt: Date.now(), title: body.title || '未命名', templateId: body.templateId, ask: body.ask ?? '', attachments: atts.length ? atts : [sampleDoc] });
    return ok(getRun(id));
  }
  const retry = path.match(/\/runs\/([^/]+)\/retry$/);
  if (retry) {
    const f = fixedRuns[retry[1]];
    if (!f || f.status !== 'failed') return fail('这个任务现在不需要恢复', 'NOT_FOUND');
    /* 只重做没完成的部分：已完成的幕原样保留 */
    const keep = new Map<number, QcScene['status']>();
    const redo: number[] = [];
    (f.scenes ?? []).forEach((sc, i) => { if (sc.status === 'ready' || sc.status === 'drawn') keep.set(i, sc.status); else redo.push(i); });
    const kind = body.action === 'requeue' ? 'requeue' : f.failure?.stageKey === 'voice' ? 'scene' : 'step';
    if (body.action === 'skip-unit') { redo.forEach(i => keep.set(i, 'ready')); redo.length = 0; }
    recovering.set(retry[1], { kind, startedAt: Date.now(), base: f, keep, redo });
    return ok(getRun(retry[1]));
  }
  const publish = path.match(/\/runs\/([^/]+)\/publish$/);
  if (publish) {
    const id = publish[1];
    const tries = (publishTries.get(id) ?? 0) + 1;
    publishTries.set(id, tries);
    await new Promise(r => setTimeout(r, 500));
    /* 第一次发布故意失败，用来演示重试；之后成功 */
    if (tries === 1 && id !== 'run-publish-failed') return fail('网页托管这次没有响应（14:21）');
    publishedAt.set(id, '14:23');
    return ok(getRun(id));
  }
  const runMatch = path.match(/\/runs\/([^/]+)$/);
  if (runMatch) {
    const r = getRun(runMatch[1]);
    return r ? ok(r) : fail('没有找到这个任务，可能已被删除', 'NOT_FOUND');
  }
  return ok(null);
};

try { Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true }); } catch { /* 忽略 */ }
export {};
