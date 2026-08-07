import type { Layer, PixelData, Psd } from 'ag-psd';
import { createWorkspaceImageGenRun, getImageGenRun, streamImageGenRunWithRetry } from '@/services';
import type { ImageGenGenerateResponse, ImageGenImage, ImageGenRunStreamPayload } from '@/services/contracts/imageGen';
import type { ApiResponse } from '@/types/api';

/** ApiResponse 是三字段闭合形状（success/data/error），这两个小工具避免每处都手写 null。 */
function failed<T>(code: string, message: string): ApiResponse<T> {
  return { success: false, data: null, error: { code, message } };
}
function succeeded<T>(data: T): ApiResponse<T> {
  return { success: true, data, error: null };
}

const LAYERING_PROMPT =
  'Decompose this image into semantically distinct editable RGBA layers. Preserve composition and transparent edges.';

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
  signal?: AbortSignal;
  /** 等待期的可见进度：分层要跑几十秒，静止的「加载中」超过 2 秒就是体验缺陷。 */
  onProgress?: (progress: { phase: string; completed: number; total: number }) => void;
  /**
   * 每有一个图层出图就回调一次，让调用方当场把它画到画布上。
   * 只报进度是不够的——用户要看的是图层本身在长出来，不是一句「已生成 2/4」。
   */
  onLayer?: (layer: { index: number; url: string }) => void;
}): Promise<ApiResponse<ImageGenGenerateResponse>> {
  const layerCount = Math.max(1, Math.min(10, Math.round(input.layerCount ?? 4)));
  const sourceSha256 = String(input.sourceSha256 ?? '').trim();
  const sourceUrl = /^https:\/\//i.test(input.source) ? input.source : '';
  if (!sourceSha256 && !sourceUrl) {
    // 异步任务由 Worker 在后台读取原图，没有前端这次请求的 body 可用，
    // 因此原图必须已经落盘（有 sha256）或有可直取的 URL。
    return failed('INVALID_FORMAT', '原图尚未保存，请先等待图片同步完成再分层');
  }

  const runRes = await createWorkspaceImageGenRun({
    id: input.workspaceId,
    input: {
      operation: 'layering',
      layerCount,
      prompt: LAYERING_PROMPT,
      targetKey: input.targetKey,
      responseFormat: 'url',
      imageRefs: [{ refId: 1, assetSha256: sourceSha256, url: sourceUrl, label: '待分层原图' }],
    },
    idempotencyKey: `imLayer_${input.workspaceId}_${input.targetKey}_${layerCount}`,
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
    if (collected.size > 0) return succeeded({ images: sortedImages(collected) });
    const status = res.data.run.status;
    if (status === 'Failed' || status === 'Cancelled') {
      const failedItem = (res.data.items ?? []).find((item) => item.errorMessage);
      return failed(
        'RUN_FAILED',
        status === 'Cancelled' ? '分层已取消' : (failedItem?.errorMessage || streamFailure || '分层失败'),
      );
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
  const semanticLayers: Layer[] = input.layers.map((layer) => ({
    name: layer.name,
    imageData: clonePixelData(layer.image),
    opacity: normalizedOpacity(layer.opacity),
    hidden: layer.hidden === true,
  }));
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

async function loadImageData(source: string, targetSize?: { width: number; height: number }): Promise<PixelData> {
  const response = await fetch(source, { mode: 'cors' });
  if (!response.ok) throw new Error(`读取图层失败：HTTP ${response.status}`);
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
  opacity?: number;
  hidden?: boolean;
};

async function loadLayerImages(input: { source: string; layerSources: LayerSourceInput[] }) {
  const source = await loadImageData(input.source);
  const layers = await Promise.all(
    input.layerSources.map(async (layer) => ({
      name: layer.name,
      opacity: layer.opacity,
      hidden: layer.hidden,
      image: await loadImageData(layer.source, { width: source.width, height: source.height }),
    })),
  );
  return { source, layers };
}

export async function createLayeredPsdBlob(input: {
  source: string;
  layerSources: LayerSourceInput[];
}): Promise<Blob> {
  if (input.layerSources.length === 0) throw new Error('分层模型未返回可用图层');

  const { source, layers } = await loadLayerImages(input);
  const document = buildLayeredPsdDocument({ source, layers });
  const { writePsd } = await import('ag-psd');
  const buffer = writePsd(document, { noBackground: true, trimImageData: true });
  return new Blob([buffer], { type: 'image/vnd.adobe.photoshop' });
}

/**
 * 按图层面板当前的显隐 / 不透明度 / 叠放次序拍平成一张 PNG。
 * 「所见即所得」的那个「所得」：面板上看到的合成预览就是这张图。
 */
export async function createCompositePngBlob(input: {
  source: string;
  layerSources: LayerSourceInput[];
}): Promise<Blob> {
  const visible = input.layerSources.filter((layer) => layer.hidden !== true);
  if (visible.length === 0) throw new Error('当前没有可见图层，合成图会是空的');

  const { source, layers } = await loadLayerImages({ source: input.source, layerSources: visible });
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
