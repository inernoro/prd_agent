import { createImageGenRun, getImageGenRun, getVisualAgentText2ImgModels } from '@/services';
import type { BackdropAsset } from './backdropRotation';

/**
 * 自己生成一张背景图。
 *
 * 走的是产品自己的生图链路（`appKey: 'visual-agent'` → 后端解析成
 * `visual-agent.image.text2img::generation`），不是另开一条特殊通道——
 * 背景图也是这个产品的产物，没有理由用别的路子出。
 *
 * 用**任务化 run**（`POST image-gen/runs` + 轮询）而不是同步的 `generate`：
 * 实测出一张 1536x1024 要 45 秒左右，同步接口会先被 CDN 边缘按超时掐断
 * （504），拿不到结果。run 落库、断线可续，是这类耗时的正确形态。
 */

/** 生成期的阶段。文案由调用方渲染，这里只负责说清「现在在哪一步」。 */
export type BackdropGenPhase = 'resolving' | 'queued' | 'running' | 'saving';

export type BackdropGenProgress = {
  phase: BackdropGenPhase;
  /** 已经等了多少毫秒。等待期必须有持续变化的东西，这是它的数据源。 */
  elapsedMs: number;
};

/**
 * 背景图的硬约束。
 *
 * 这段是**不给用户改的**：随包那四张就是按它生成的，用户换的只是「氛围」那一句。
 * 理由是这些约束一旦被改掉（出现主体、出现文字、整体变亮），出来的东西就不再是背景图，
 * 而是一张压在正文底下看不清、又把对比度毁掉的插画。见 backdropCatalog.ts 的取证注释。
 */
const BACKDROP_CONSTRAINTS =
  '极简暗调抽象背景图，近黑底色，整体亮度极低，大量负空间，细腻胶片颗粒质感。'
  + '画面中没有任何文字、没有主体物、没有人物、没有清晰的几何边缘。适合作为深色界面的背景图。';

/** 预填给用户的氛围建议。零摩擦：输入框不留空，用户改的是差异而不是全部。 */
export const BACKDROP_MOOD_SUGGESTIONS: readonly string[] = [
  '一道暖赤陶色的柔光从画面左上角斜切进来，像暗房里门缝漏进的一束光',
  '画面下方三分之一处有一片极暗的暖橘色余烬般的辉光，向上渐隐入纯黑',
  '一层极淡的暖灰色雾气横贯画面中部，上下都沉入黑色',
  '一团暖赤陶色的柔和光晕从画面上方弥散开来，边缘极其柔和',
];

/** 拼出最终提示词：用户那句氛围在前，硬约束在后（后写的约束不会被前面的描述带偏）。 */
export function buildBackdropPrompt(mood: string): string {
  const m = mood.trim().replace(/[。.\s]+$/, '');
  return m ? `${m}。${BACKDROP_CONSTRAINTS}` : BACKDROP_CONSTRAINTS;
}

/** 每台设备最多留几张自己生成的。留太多只会让钉图网格变成垃圾场。 */
export const MAX_GENERATED = 8;

/**
 * 按账号分键。
 *
 * 这里存的是**用户自己生成的图**的地址，不是主题、排序那类设备偏好。
 * 用一个全局键存它，等于把 A 的产物留在浏览器里给下一个登录的人看：
 * 共用电脑上 A 退出、B 登录，首页和背景设置里就会列出 A 生成的背景
 * （Codex PR #1476 P1）。`no-localstorage.md` 允许 localStorage 的前提是
 * 「非敏感 + 设备本地 + 旧值无害」，用户产物不满足第一条。
 *
 * 分键之后 B 读的是另一个键，天然看不到 A 的东西，不需要额外在登出时清理。
 * 拿不到 userId（未登录）时返回空键，调用方一律当作没有数据——
 * 宁可这一屏少几张自己生成的背景，也不要落到一个人人可读的桶里。
 */
function generatedKeyOf(userId: string): string {
  const uid = String(userId ?? '').trim();
  return uid ? `visualAgent.backdrop.generated.${uid}` : '';
}

/** 读本机生成过的背景。存的是 COS 地址——图挂了就加载不出来，那一层自己不渲染，页面照常成立。 */
export function readGeneratedBackdrops(userId: string): BackdropAsset[] {
  const key = generatedKeyOf(userId);
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x.id === 'string' && typeof x.url === 'string' && x.url)
      .slice(0, MAX_GENERATED)
      .map((x) => ({ id: String(x.id), name: String(x.name || '我生成的'), url: String(x.url), note: x.note ? String(x.note) : undefined }));
  } catch {
    // 隐私模式 / 禁用站点数据时读取会抛，此时当作没有，不能让首页崩。
    return [];
  }
}

/** 新的排在最前，超出上限的挤掉最旧的。返回写入后的完整列表，调用方直接拿去渲染。 */
export function pushGeneratedBackdrop(userId: string, next: BackdropAsset, existing: readonly BackdropAsset[] = readGeneratedBackdrops(userId)): BackdropAsset[] {
  const list = [next, ...existing.filter((x) => x.id !== next.id)].slice(0, MAX_GENERATED);
  const key = generatedKeyOf(userId);
  if (!key) return list;
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* 存不下就只在本次会话生效，不打断用户 */
  }
  return list;
}

export function removeGeneratedBackdrop(userId: string, id: string, existing: readonly BackdropAsset[] = readGeneratedBackdrops(userId)): BackdropAsset[] {
  const list = existing.filter((x) => x.id !== id);
  const key = generatedKeyOf(userId);
  if (!key) return list;
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* 同上 */
  }
  return list;
}

type PoolLike = {
  isDefaultForType?: boolean;
  models?: { modelId?: string | null; platformId?: string | null }[] | null;
};

/**
 * 从生图模型池里挑一个能用的成员。
 *
 * 优先默认池（`isDefaultForType`），否则取第一个有成员的池。
 * 不硬编码 `image1`——那是**当前**默认池的 code，写死了以后换池就静默指向一个不存在的模型。
 */
export function pickGenerationModel(pools: readonly PoolLike[] | null | undefined): { platformId: string; modelId: string } | null {
  const usable = (pools ?? []).filter((p) => (p.models ?? []).some((m) => m?.modelId && m?.platformId));
  const chosen = usable.find((p) => p.isDefaultForType) ?? usable[0];
  const member = (chosen?.models ?? []).find((m) => m?.modelId && m?.platformId);
  if (!member?.modelId || !member?.platformId) return null;
  return { platformId: String(member.platformId), modelId: String(member.modelId) };
}

export class BackdropGenError extends Error {}

const POLL_INTERVAL_MS = 2_500;
/** 实测一张 1536x1024 约 45s。留到 5 分钟，超了就当它不会回来了。 */
const TIMEOUT_MS = 300_000;

/**
 * 生成一张背景图，成功时返回可直接用的素材。
 *
 * 失败一律抛 {@link BackdropGenError} 并带上人话原因——「操作失败」四个字对用户没有任何用。
 */
export async function generateBackdrop(args: {
  mood: string;
  signal?: AbortSignal;
  onProgress?: (p: BackdropGenProgress) => void;
  now?: () => number;
  /** 轮询间隔。留成参数只是为了单测别真等 2.5 秒一轮，生产走默认值。 */
  pollIntervalMs?: number;
}): Promise<BackdropAsset> {
  const now = args.now ?? (() => Date.now());
  const pollInterval = args.pollIntervalMs ?? POLL_INTERVAL_MS;
  const startedAt = now();
  const report = (phase: BackdropGenPhase) => args.onProgress?.({ phase, elapsedMs: now() - startedAt });

  report('resolving');
  // 背景生成从不给输入图，是纯文生图。必须查 text2img 专用目录：
  // 合并目录里混着 img2img / vision-only 池，若其中之一恰好排在前面或被标为默认，
  // pickGenerationModel 会选中它，之后每一次背景生成都必然失败——而画面上只会
  // 显示「生成失败」，看不出是选错了池（Codex PR #1476 P2）。
  const poolsRes = await getVisualAgentText2ImgModels();
  if (!poolsRes.success) throw new BackdropGenError(poolsRes.error?.message || '拿不到可用的生图模型');
  const model = pickGenerationModel(poolsRes.data);
  if (!model) throw new BackdropGenError('当前没有可用的生图模型，去「模型池」里给文生图配一个再来');

  const createRes = await createImageGenRun({
    input: {
      platformId: model.platformId,
      modelId: model.modelId,
      appKey: 'visual-agent',
      size: '1536x1024',
      responseFormat: 'url',
      maxConcurrency: 1,
      items: [{ prompt: buildBackdropPrompt(args.mood), count: 1, size: '1536x1024' }],
    },
  });
  if (!createRes.success || !createRes.data?.runId) {
    throw new BackdropGenError(createRes.error?.message || '生成任务没建起来');
  }
  const runId = createRes.data.runId;

  report('queued');
  for (;;) {
    if (args.signal?.aborted) throw new BackdropGenError('已取消');
    if (now() - startedAt > TIMEOUT_MS) throw new BackdropGenError('等了 5 分钟还没出图，先放着吧，稍后再试');

    await new Promise((r) => setTimeout(r, pollInterval));
    if (args.signal?.aborted) throw new BackdropGenError('已取消');

    const res = await getImageGenRun({ runId, includeItems: true, includeImages: true });
    if (!res.success) continue; // 单次查询失败不算失败，下一轮接着问
    const run = res.data?.run;
    const item = (res.data?.items ?? [])[0];
    report(run?.status === 'Running' ? 'running' : run?.status === 'Completed' ? 'saving' : 'queued');

    if (item?.status === 'Done' && item.url) {
      return {
        id: `gen-${runId}`,
        name: '我生成的',
        url: item.url,
        note: new Date(now()).toLocaleDateString(),
      };
    }
    if (item?.status === 'Failed' || run?.status === 'Failed') {
      throw new BackdropGenError(item?.errorMessage || '模型没能出图');
    }
    if (run?.status === 'Cancelled') throw new BackdropGenError('任务已取消');
  }
}
