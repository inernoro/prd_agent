import type { Layer, PixelData, Psd } from 'ag-psd';
import { createWorkspaceImageGenRun, getImageGenRun, streamImageGenRunWithRetry } from '@/services';
import type { ImageGenGenerateResponse, ImageGenImage, ImageGenRunStreamPayload } from '@/services/contracts/imageGen';
import type { ApiResponse } from '@/types/api';
import { useAuthStore } from '@/stores/authStore';
import { computeAlphaBounds, cropRgba } from './layerTrim';

/** ApiResponse 是三字段闭合形状（success/data/error），这两个小工具避免每处都手写 null。 */
function failed<T>(code: string, message: string): ApiResponse<T> {
  return { success: false, data: null, error: { code, message } };
}
function succeeded<T>(data: T): ApiResponse<T> {
  return { success: true, data, error: null };
}

/** 幂等键后缀：不传 attempt 时保持原样，避免既有调用方的键形状变化。 */
export function attemptSuffix(attempt: string | number | undefined | null): string {
  const value = String(attempt ?? '').trim();
  return value ? `_${value.replace(/[^A-Za-z0-9_-]/g, '')}` : '';
}

const LAYERING_PROMPT =
  'Decompose this image into semantically distinct editable RGBA layers. Preserve composition and transparent edges.';

/**
 * 把用户自己的话拼进分层提示词。
 *
 * 层数表达不了「我就想把人物和风景分开」这种意图：选 2 层完全可能拆出「人物 + 冰淇淋」
 * （2026-08-10 用户原话）。所以意图是主入口，层数只是附带的期望值。
 * 用户的话原样附在后面，不改写、不翻译——改写就等于替他做决定（最小惊讶）。
 */
export function buildLayeringPrompt(intent?: string | null): string {
  const wish = String(intent ?? '').trim();
  if (!wish) return LAYERING_PROMPT;
  return `${LAYERING_PROMPT}\nUser intent for how to split (follow it): ${wish}`;
}

/**
 * 语义分层。
 *
 * 走异步任务而不是同步端点：分层模型本身要二三十秒，实测两次都稳定卡在 30.7 秒后 504——
 * 那是边缘网关的 30 秒上限，跟模型快慢无关，同步这条路怎么优化都拿不到结果。
 * 改成「提交拿任务号 → 订阅进度 → Worker 落库」之后，产物与 HTTP 连接的存活时间脱钩。
 *
 * 仍返回同步端点那套 { images } 形状，调用方读结果的代码不用跟着改。
 */
export async function decomposeImageToLayers(input: {
  workspaceId: string;
  targetKey: string;
  source: string;
  sourceSha256?: string | null;
  layerCount?: number;
  /**
   * 重拆标记。幂等键只由 workspace + 目标 + 层数组成，同样的层数再点「重新拆分」
   * 会命中同一个 run 而直接返回上次的结果——看起来像按钮没反应。
   * 重拆时传一个变化的值，让它落到不同的 run 上。
   */
  attempt?: string | number;
  /** 用自然语言说的拆法，会原样附进提示词。 */
  intent?: string | null;
  signal?: AbortSignal;
  /** 等待期的可见进度：分层要跑几十秒，静止的「加载中」超过 2 秒就是体验缺陷。 */
  onProgress?: (progress: { phase: string; completed: number; total: number }) => void;
  /**
   * 每有一个图层出图就回调一次，让调用方当场把它画到画布上。
   * 只报进度是不够的——用户要看的是图层本身在长出来，不是一句「已生成 2/4」。
   */
  onLayer?: (layer: { index: number; url: string }) => void;
  /** 本次实际落到的模型；后端解析出来才回调，报不出来就不回调。 */
  onModel?: (model: string) => void;
}): Promise<ApiResponse<ImageGenGenerateResponse>> {
  const layerCount = Math.max(1, Math.min(10, Math.round(input.layerCount ?? 4)));
  const sourceSha256 = String(input.sourceSha256 ?? '').trim();
  const sourceUrl = /^https:\/\//i.test(input.source) ? input.source : '';
  if (!sourceSha256) {
    // 异步任务由 Worker 在后台读取原图，没有前端这次请求的 body 可用，因此原图必须已经落盘。
    // 这里**只认 sha**：Worker 的参考图加载对没有 sha 的条目是直接 continue 跳过的
    //（ImageGenRunWorker「if (IsNullOrWhiteSpace(resolvedRef.AssetSha256)) continue」），
    // 所以「有 https 直链就能拆」这条兜底从来没成立过——放行只会让用户在几十秒后
    // 收到一句没头没尾的 IMAGE_REF_UNAVAILABLE，而不是当场知道「等图同步完再来」。
    // 不假装拥有并不具备的能力（.claude/rules/no-rootless-tree.md），Codex PR #1363 P2。
    return failed('INVALID_FORMAT', '原图尚未保存，请先等待图片同步完成再分层');
  }

  const runRes = await createWorkspaceImageGenRun({
    id: input.workspaceId,
    input: {
      operation: 'layering',
      layerCount,
      prompt: buildLayeringPrompt(input.intent),
      targetKey: input.targetKey,
      responseFormat: 'url',
      imageRefs: [{ refId: 1, assetSha256: sourceSha256, url: sourceUrl, label: '待分层原图' }],
    },
    idempotencyKey: `imLayer_${input.workspaceId}_${input.targetKey}_${layerCount}${attemptSuffix(input.attempt)}`,
  });
  if (!runRes.success) return failed(runRes.error?.code ?? 'RUN_FAILED', runRes.error?.message ?? '分层任务创建失败');
  const runId = String(runRes.data?.runId ?? '').trim();
  if (!runId) return failed('INVALID_FORMAT', '分层任务未返回任务号');

  const images = await collectLayeringRunImages({
    runId,
    total: layerCount,
    signal: input.signal,
    onProgress: input.onProgress,
    onLayer: input.onLayer,
    onModel: input.onModel,
  });
  if (!images.success) return images;
  if (images.data!.images.length === 0) {
    return failed('EMPTY_RESULT', '分层任务完成但没有返回图层');
  }
  return images;
}

/**
 * 订阅任务进度收集图层，流断了再用一次查询兜底。
 *
 * SSE 断开不等于任务失败（服务器权威）：代理 EOF、重试耗尽都会走到流结束，
 * 而 Worker 可能仍在跑或已经跑完。所以流结束后必须再查一次真实状态才能下结论。
 */
async function collectLayeringRunImages(input: {
  runId: string;
  total: number;
  signal?: AbortSignal;
  onProgress?: (progress: { phase: string; completed: number; total: number }) => void;
  onLayer?: (layer: { index: number; url: string }) => void;
  onModel?: (model: string) => void;
}): Promise<ApiResponse<ImageGenGenerateResponse>> {
  const { runId, total } = input;
  const collected = new Map<number, ImageGenImage>();
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  input.signal?.addEventListener('abort', relayAbort);
  let streamFailure: string | null = null;

  const report = (phase: string) => input.onProgress?.({ phase, completed: collected.size, total });
  report('已提交分层任务，正在等待模型');

  try {
    await streamImageGenRunWithRetry({
      runId,
      maxAttempts: 20,
      signal: controller.signal,
      onEvent: (evt) => {
        const raw = String(evt.data ?? '').trim();
        if (!raw) return;
        let payload: ImageGenRunStreamPayload;
        try {
          payload = JSON.parse(raw) as ImageGenRunStreamPayload;
        } catch {
          return;
        }
        const type = String(payload.type ?? '');
        // 谁拆的这一组，用户有权知道（ai-model-visibility）。只报后端解析出来的真值，
        // 报不出来就整行不显示——不许前端写死一个模型名冒充。
        const resolvedModel = String(payload.modelId ?? payload.logicalModelPublicId ?? '').trim();
        if (resolvedModel) input.onModel?.(resolvedModel);
        if (type === 'imageDone') {
          const url = String(payload.asset?.originalUrl || payload.asset?.url || payload.originalUrl || payload.url || '').trim();
          if (!url) return;
          const index = Number(payload.imageIndex ?? collected.size);
          const slot = Number.isFinite(index) ? index : collected.size;
          const isNewSlot = !collected.has(slot);
          collected.set(slot, {
            index: slot,
            url,
            originalUrl: url,
            originalSha256: String(payload.asset?.originalSha256 || payload.asset?.sha256 || ''),
          });
          if (isNewSlot) input.onLayer?.({ index: slot, url });
          report(`已生成 ${collected.size}/${total} 个图层`);
          if (collected.size >= total) controller.abort();
        } else if (type === 'imageError' || type === 'error') {
          streamFailure = String(payload.errorMessage ?? '分层失败');
        }
      },
    });
  } catch {
    // 流本身出错不下结论，交给下面的状态查询。
  } finally {
    input.signal?.removeEventListener('abort', relayAbort);
  }

  if (collected.size >= total) return succeeded({ images: sortedImages(collected) });
  if (input.signal?.aborted) return failed('CANCELLED', '已取消');

  report('正在确认分层结果');
  const res = await getImageGenRun({ runId, includeItems: true, includeImages: true });
  if (res.success && res.data?.run) {
    for (const item of res.data.items ?? []) {
      const url = String(item.url ?? '').trim();
      if (!url) continue;
      const slot = Number(item.imageIndex ?? collected.size);
      const isNewSlot = !collected.has(slot);
      collected.set(slot, { index: slot, url, originalUrl: url });
      // 流断了才走到这里：补回来的图层同样要点亮画布，否则占位卡会一直空着。
      if (isNewSlot) input.onLayer?.({ index: slot, url });
    }
    const status = res.data.run.status;
    if (status === 'Failed' || status === 'Cancelled') {
      const failedItem = (res.data.items ?? []).find((item) => item.errorMessage);
      return failed(
        'RUN_FAILED',
        status === 'Cancelled' ? '分层已取消' : (failedItem?.errorMessage || streamFailure || '分层失败'),
      );
    }
    // 只有跑到终态才认「就这些了」。
    // 原来是「捞到几张就算成功」，而 SSE 重试耗尽时 run 完全可能还是 Queued/Running：
    // 调用方据此判定完成、清掉剩下的占位卡、也不再跟这条 run，于是 Worker 随后落的
    // 图层永远到不了画布——用户看到的是「说好 4 层只出了 2 层，刷新也回不来」
    // （Codex PR #1363 P1）。模型少给几层是另一回事：那时 run 是 Completed，照收。
    if (status === 'Completed') {
      if (collected.size > 0) return succeeded({ images: sortedImages(collected) });
      return failed('RUN_FAILED', streamFailure || '分层完成但没有返回任何图层');
    }
    return failed('RUN_PENDING', '分层仍在后台进行，稍后可在画布中查看结果');
  }
  return failed('RUN_FAILED', streamFailure || '分层失败，请重试');
}

function sortedImages(collected: Map<number, ImageGenImage>): ImageGenImage[] {
  return [...collected.entries()].sort((a, b) => a[0] - b[0]).map(([, image]) => image);
}

function clonePixelData(image: PixelData): PixelData {
  return {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data),
  };
}

export function compositePixelLayers(layers: PixelData[], width: number, height: number): PixelData {
  const output = new Uint8ClampedArray(width * height * 4);
  for (const layer of layers) {
    if (layer.width !== width || layer.height !== height) {
      throw new Error('图层尺寸必须与 PSD 画布一致');
    }
    for (let offset = 0; offset < output.length; offset += 4) {
      const sourceAlpha = layer.data[offset + 3]! / 255;
      if (sourceAlpha <= 0) continue;
      const destinationAlpha = output[offset + 3]! / 255;
      const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
      if (outputAlpha <= 0) continue;
      for (let channel = 0; channel < 3; channel += 1) {
        output[offset + channel] = Math.round((
          layer.data[offset + channel]! * sourceAlpha
          + output[offset + channel]! * destinationAlpha * (1 - sourceAlpha)
        ) / outputAlpha);
      }
      output[offset + 3] = Math.round(outputAlpha * 255);
    }
  }
  return { width, height, data: output };
}

/** 把不透明度烘进像素的 alpha，用于合成预览；图层本身另外带 opacity 交给 PSD。 */
function applyOpacity(image: PixelData, opacity: number): PixelData {
  if (opacity >= 1) return image;
  const scaled = new Uint8ClampedArray(image.data);
  const factor = Math.max(0, opacity);
  for (let offset = 3; offset < scaled.length; offset += 4) {
    scaled[offset] = Math.round(scaled[offset]! * factor);
  }
  return { width: image.width, height: image.height, data: scaled };
}

/** 图层面板里的显隐与不透明度必须一路带到产物，否则「所见」和「所download」两套结果。 */
export type PsdLayerInput = {
  name: string;
  image: PixelData;
  /** 0–1，缺省 1。 */
  opacity?: number;
  /** 关掉眼睛的图层：仍写进 PSD（可在 Photoshop 里打开），但不参与合成。 */
  hidden?: boolean;
};

function normalizedOpacity(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

export function buildLayeredPsdDocument(input: {
  source: PixelData;
  layers: PsdLayerInput[];
}): Psd {
  // 每层只写「有内容的最小矩形」，而不是满幅。
  // 满幅写法在 Photoshop 里的后果是：每一层的变换框都套着整张画布，想把 logo 挪一点
  // 得自己先找边界；文件也大好几倍。裁完写 top/left/bottom/right 才是真正的分层文档。
  const semanticLayers: Layer[] = input.layers.map((layer) => {
    const image = layer.image;
    const bounds = computeAlphaBounds(image.data, image.width, image.height);
    const cropped = bounds ? cropRgba(image.data, image.width, image.height, bounds) : null;
    if (!bounds || !cropped) {
      // 整层全透明：给一个零面积的空图层占位，保住序号与可见性，但不占画布。
      return {
        name: layer.name,
        top: 0, left: 0, bottom: 0, right: 0,
        opacity: normalizedOpacity(layer.opacity),
        hidden: layer.hidden === true,
      };
    }
    return {
      name: layer.name,
      top: bounds.top,
      left: bounds.left,
      bottom: bounds.bottom,
      right: bounds.right,
      imageData: { width: cropped.width, height: cropped.height, data: cropped.data },
      opacity: normalizedOpacity(layer.opacity),
      hidden: layer.hidden === true,
    };
  });
  const composite = compositePixelLayers(
    input.layers
      .filter((layer) => layer.hidden !== true)
      .map((layer) => applyOpacity(layer.image, normalizedOpacity(layer.opacity))),
    input.source.width,
    input.source.height,
  );

  return {
    width: input.source.width,
    height: input.source.height,
    imageData: composite,
    children: [
      {
        name: 'AI 可编辑图层',
        opened: true,
        children: semanticLayers,
      },
      {
        name: '原图参考（隐藏，不参与合成）',
        hidden: true,
        imageData: clonePixelData(input.source),
      },
    ],
  };
}

/**
 * PSD / 合成 PNG 都要把图片读成像素，读不到就是整条导出链路失败。
 *
 * 直接 fetch 图片地址在对象存储部署上会撞 CORS —— 浏览器抛的是没有任何上下文的
 * `Failed to fetch`，用户只看到「PSD 导出失败 Failed to fetch」，完全无法自测。
 * 本站的 `assets/file/{sha}` 是同源的，只要资产已经落库就一定能读，
 * 所以有 sha 时一律改走同源地址，跨域地址只作最后兜底。
 */
export function resolveReadableImageUrl(source: string, sha256?: string | null): string {
  const sha = String(sha256 ?? '').trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(sha)) return `/api/visual-agent/image-master/assets/file/${sha}`;

  const raw = String(source ?? '').trim();
  if (!raw) return raw;
  // 已经是本站地址（相对路径或同源绝对路径）就原样用。
  if (raw.startsWith('/')) return raw;
  if (raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
  try {
    if (typeof window !== 'undefined' && new URL(raw).origin === window.location.origin) return raw;
  } catch {
    // 解析不了的地址交给 fetch 自己报错，这里不猜。
  }
  // 从资产地址里把 sha 抠出来：跨域 COS 链接的文件名通常就是 sha。
  const embedded = raw.match(/([0-9a-f]{64})(?:\.[a-z0-9]+)?(?:[?#]|$)/i);
  if (embedded) return `/api/visual-agent/image-master/assets/file/${embedded[1]!.toLowerCase()}`;
  return raw;
}

/**
 * 读本站图片要带上登录凭据。
 *
 * `/api/visual-agent/image-master/assets/file/{sha}` 是 [Authorize] 端点，裸 fetch 一律 401。
 * 页面上的 <img> 显示走的是对象存储直链所以看不出来，但**用 fetch 读像素**的两条路
 * （导出 PSD / 合成 PNG、分层内容判定）都会栽在这里：判定悄悄失败退回普通层，
 * 面板上那行「正在识别内容…」就永远停着（2026-08-10 真机截图实测）。
 *
 * 只对同源地址加 header：跨域外链带 Bearer 等于把凭据送给第三方主机。
 */
export function readableImageFetchHeaders(url: string): Record<string, string> {
  const raw = String(url ?? '').trim();
  const sameOrigin = raw.startsWith('/')
    || (typeof window !== 'undefined' && (() => {
      try { return new URL(raw, window.location.href).origin === window.location.origin; }
      catch { return false; }
    })());
  if (!sameOrigin) return {};
  try {
    const token = useAuthStore.getState().token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function loadImageData(
  source: string,
  targetSize?: { width: number; height: number },
  meta?: { label?: string; sha256?: string | null },
): Promise<PixelData> {
  const label = meta?.label ? `「${meta.label}」` : '';
  const url = resolveReadableImageUrl(source, meta?.sha256);

  let response: Response;
  try {
    response = await fetch(url, { mode: 'cors', headers: readableImageFetchHeaders(url) });
  } catch (error) {
    // 把 `Failed to fetch` 翻译成能行动的话：说清是哪一层、读的哪个地址、下一步做什么。
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `读取${label || '图片'}失败（${reason}）。地址：${url}。`
      + (url.startsWith('/api/') ? '该图可能尚未同步到本站资产，等右上角「同步中」消失后重试。' : '该图是跨域外链且未开放 CORS，请等它同步到本站资产后再导出。'),
    );
  }
  if (!response.ok) throw new Error(`读取${label || '图片'}失败：HTTP ${response.status}（${url}）`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);

  try {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('图层图片解码失败'));
      image.src = objectUrl;
    });

    const width = targetSize?.width ?? image.naturalWidth;
    const height = targetSize?.height ?? image.naturalHeight;
    if (!width || !height) throw new Error('图层尺寸无效');

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('浏览器不支持 Canvas 2D');
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** 图层面板交给下载链路的一层：顺序即数组顺序（先画的在下）。 */
export type LayerSourceInput = {
  name: string;
  source: string;
  /** 有 sha 就走同源资产地址读图，绕开对象存储的 CORS。 */
  sha256?: string | null;
  opacity?: number;
  hidden?: boolean;
};

async function loadLayerImages(input: {
  source: string;
  sourceSha256?: string | null;
  layerSources: LayerSourceInput[];
}) {
  const source = await loadImageData(input.source, undefined, {
    label: '原图',
    sha256: input.sourceSha256,
  });
  const layers = await Promise.all(
    input.layerSources.map(async (layer) => ({
      name: layer.name,
      opacity: layer.opacity,
      hidden: layer.hidden,
      image: await loadImageData(
        layer.source,
        { width: source.width, height: source.height },
        { label: layer.name, sha256: layer.sha256 },
      ),
    })),
  );
  return { source, layers };
}

export async function createLayeredPsdBlob(input: {
  source: string;
  sourceSha256?: string | null;
  layerSources: LayerSourceInput[];
}): Promise<Blob> {
  if (input.layerSources.length === 0) throw new Error('分层模型未返回可用图层');

  const { source, layers } = await loadLayerImages(input);
  const document = buildLayeredPsdDocument({ source, layers });
  const { writePsd } = await import('ag-psd');
  const buffer = writePsd(document, { noBackground: true, trimImageData: true });
  return new Blob([buffer], { type: 'image/vnd.adobe.photoshop' });
}

export type FramePsdElement = {
  name: string;
  source: string;
  sha256?: string | null;
  /** 元素在画布世界坐标里的位置与尺寸。 */
  x: number;
  y: number;
  w: number;
  h: number;
  opacity?: number;
  hidden?: boolean;
};

/**
 * 把一个 Frame（任意一组画布元素）导成分层 PSD。
 *
 * 和 AI 分层那条路的区别只有一处：那边每层本来就是与原图等大的满幅图，这边每个元素
 * 各在画布上占一小块。所以这里先按 Frame 的包围盒开一张透明画布，把每个元素画到它
 * 该在的位置，再交给**同一个** buildLayeredPsdDocument——裁剪、逐层包围盒、图层组结构
 * 全部复用，不另写一套（否则两条导出路迟早在「层怎么写」上漂移）。
 *
 * 用户诉求（2026-08-11）：「有 frame 的情况下可以直接在 frame 上下载 psd」。
 */
export async function createFramePsdBlob(input: {
  width: number;
  height: number;
  /** 元素坐标相对于哪一点（Frame 左上角的世界坐标）。 */
  originX: number;
  originY: number;
  elements: FramePsdElement[];
}): Promise<Blob> {
  const width = Math.max(1, Math.round(input.width));
  const height = Math.max(1, Math.round(input.height));
  if (input.elements.length === 0) throw new Error('这个 Frame 里没有可导出的元素');

  const layers: PsdLayerInput[] = [];
  for (const element of input.elements) {
    const image = await loadImageData(element.source, undefined, {
      label: element.name,
      sha256: element.sha256,
    });
    layers.push({
      name: element.name,
      image: drawIntoCanvasFrame(image, {
        width,
        height,
        x: Math.round(element.x - input.originX),
        y: Math.round(element.y - input.originY),
        w: Math.max(1, Math.round(element.w)),
        h: Math.max(1, Math.round(element.h)),
      }),
      opacity: element.opacity,
      hidden: element.hidden,
    });
  }

  // 参考层用「全部元素拍平」的结果，而不是某一张原图——普通编组没有「原图」这个概念。
  const flattened = compositePixelLayers(
    layers.filter((layer) => layer.hidden !== true).map((layer) => layer.image),
    width,
    height,
  );
  const document = buildLayeredPsdDocument({ source: flattened, layers });
  const { writePsd } = await import('ag-psd');
  const buffer = writePsd(document, { noBackground: true, trimImageData: true });
  return new Blob([buffer], { type: 'image/vnd.adobe.photoshop' });
}

/** 把一张图按给定位置与尺寸画进 width×height 的透明画布，返回整幅 RGBA。 */
function drawIntoCanvasFrame(
  image: PixelData,
  at: { width: number; height: number; x: number; y: number; w: number; h: number },
): PixelData {
  const source = document.createElement('canvas');
  source.width = image.width;
  source.height = image.height;
  const sourceContext = source.getContext('2d');
  if (!sourceContext) throw new Error('浏览器不支持 canvas，无法导出 PSD');
  sourceContext.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);

  const target = document.createElement('canvas');
  target.width = at.width;
  target.height = at.height;
  const context = target.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器不支持 canvas，无法导出 PSD');
  context.clearRect(0, 0, at.width, at.height);
  context.drawImage(source, at.x, at.y, at.w, at.h);
  const data = context.getImageData(0, 0, at.width, at.height);
  return { width: at.width, height: at.height, data: data.data };
}

/**
 * 按图层面板当前的显隐 / 不透明度 / 叠放次序拍平成一张 PNG。
 * 「所见即所得」的那个「所得」：面板上看到的合成预览就是这张图。
 */
export async function createCompositePngBlob(input: {
  source: string;
  sourceSha256?: string | null;
  layerSources: LayerSourceInput[];
}): Promise<Blob> {
  const visible = input.layerSources.filter((layer) => layer.hidden !== true);
  if (visible.length === 0) throw new Error('当前没有可见图层，合成图会是空的');

  const { source, layers } = await loadLayerImages({
    source: input.source,
    sourceSha256: input.sourceSha256,
    layerSources: visible,
  });
  const composite = compositePixelLayers(
    layers.map((layer) => applyOpacity(layer.image, normalizedOpacity(layer.opacity))),
    source.width,
    source.height,
  );

  const canvas = document.createElement('canvas');
  canvas.width = composite.width;
  canvas.height = composite.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持 Canvas 2D');
  // 走 createImageData + set：ag-psd 的 PixelArray 底层 buffer 类型与 ImageData
  // 构造签名对不上，直接 new ImageData(...) 编译不过。
  const imageData = context.createImageData(composite.width, composite.height);
  imageData.data.set(composite.data);
  context.putImageData(imageData, 0, 0);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('合成图导出失败'))),
      'image/png',
    );
  });
}

export type LayerReadinessRow = {
  name: string;
  url: string;
  ok: boolean;
  detail: string;
};

/**
 * 导出前自检：逐个确认原图与图层真的读得到。
 *
 * 存在的理由是「能自测」——不做这一步，用户点导出后要等模型图全部下载完才可能
 * 在半路炸一句 `Failed to fetch`，既不知道是哪一层，也不知道下一步该干嘛。
 * 自检只发一次轻量请求，逐行给出「哪一层 / 什么地址 / 行不行」。
 */
export async function checkLayerSourcesReadable(input: {
  source: string;
  sourceSha256?: string | null;
  layerSources: LayerSourceInput[];
}): Promise<LayerReadinessRow[]> {
  const targets = [
    { name: '原图', source: input.source, sha256: input.sourceSha256 },
    ...input.layerSources.map((layer) => ({ name: layer.name, source: layer.source, sha256: layer.sha256 })),
  ];

  return await Promise.all(targets.map(async (target) => {
    const url = resolveReadableImageUrl(target.source, target.sha256);
    if (!url) return { name: target.name, url, ok: false, detail: '没有可读取的地址' };
    try {
      // 必须带凭据：有 sha 时 resolveReadableImageUrl 返回的是 [Authorize] 的同源资产端点，
      // 裸 fetch 拿 401，于是「导出前自检」会把每一层都报成不可读，而真正的导出路径
      // （loadImageData）用了 readableImageFetchHeaders，其实是好的——自检比被检的还不准
      // （Codex PR #1363 P2）。三条读图路必须走同一个取头函数，守卫见 semanticLayerWiringGuard。
      const response = await fetch(url, { mode: 'cors', headers: readableImageFetchHeaders(url) });
      if (!response.ok) return { name: target.name, url, ok: false, detail: `HTTP ${response.status}` };
      const type = response.headers.get('content-type') || '';
      if (type && !type.startsWith('image/')) {
        return { name: target.name, url, ok: false, detail: `返回的不是图片（${type}）` };
      }
      return { name: target.name, url, ok: true, detail: '可读取' };
    } catch (error) {
      return {
        name: target.name,
        url,
        ok: false,
        detail: error instanceof Error ? error.message : '读取失败',
      };
    }
  }));
}

/** 通用下载：PSD 之外的产物（合成 PNG 等）走这里，文件名清洗规则与 PSD 一致。 */
export function downloadBlob(blob: Blob, filename: string, extension: string): void {
  const safe = String(filename || 'image')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .slice(0, 80) || 'image';
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safe}.${extension}`;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadLayeredPsd(blob: Blob, filename: string): void {
  downloadBlob(blob, filename, 'psd');
}
