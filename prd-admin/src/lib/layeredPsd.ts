import type { Layer, PixelData, Psd } from 'ag-psd';
import { api } from '@/services/api';
import { apiRequest } from '@/services/real/apiClient';
import type { ImageGenGenerateResponse } from '@/services/contracts/imageGen';
import type { ApiResponse } from '@/types/api';

async function sourceToDataUri(source: string): Promise<string> {
  if (source.startsWith('data:')) return source;

  const response = await fetch(source, { mode: 'cors' });
  if (!response.ok) throw new Error(`读取原图失败：HTTP ${response.status}`);
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('读取原图失败'));
    reader.readAsDataURL(blob);
  });
}

export async function decomposeImageToLayers(input: {
  source: string;
  sourceSha256?: string | null;
  layerCount?: number;
}): Promise<ApiResponse<ImageGenGenerateResponse>> {
  const layerCount = Math.max(1, Math.min(10, Math.round(input.layerCount ?? 4)));
  const sourceSha256 = String(input.sourceSha256 ?? '').trim();
  const sourceUrl = !sourceSha256 && /^https:\/\//i.test(input.source) ? input.source : undefined;
  const sourceDataUri = sourceSha256 || sourceUrl ? undefined : await sourceToDataUri(input.source);

  return await apiRequest<ImageGenGenerateResponse>(api.visualAgent.imageGen.generate(), {
    method: 'POST',
    body: {
      operation: 'layering',
      prompt: 'Decompose this image into semantically distinct editable RGBA layers. Preserve composition and transparent edges.',
      n: layerCount,
      responseFormat: 'url',
      initImageAssetSha256: sourceSha256 || undefined,
      initImageUrl: sourceUrl,
      initImageBase64: sourceDataUri,
    },
  });
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

export function buildLayeredPsdDocument(input: {
  source: PixelData;
  layers: Array<{ name: string; image: PixelData }>;
}): Psd {
  const semanticLayers: Layer[] = input.layers.map((layer) => ({
    name: layer.name,
    imageData: clonePixelData(layer.image),
  }));
  const composite = compositePixelLayers(
    input.layers.map((layer) => layer.image),
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

export async function createLayeredPsdBlob(input: {
  source: string;
  layerSources: Array<{ name: string; source: string }>;
}): Promise<Blob> {
  if (input.layerSources.length === 0) throw new Error('分层模型未返回可用图层');

  const source = await loadImageData(input.source);
  const layers = await Promise.all(
    input.layerSources.map(async (layer) => ({
      name: layer.name,
      image: await loadImageData(layer.source, { width: source.width, height: source.height }),
    })),
  );
  const document = buildLayeredPsdDocument({ source, layers });
  const { writePsd } = await import('ag-psd');
  const buffer = writePsd(document, { noBackground: true, trimImageData: true });
  return new Blob([buffer], { type: 'image/vnd.adobe.photoshop' });
}

export function downloadLayeredPsd(blob: Blob, filename: string): void {
  const safe = String(filename || 'image')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .slice(0, 80) || 'image';
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safe}.psd`;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
