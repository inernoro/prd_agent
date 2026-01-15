type SquareResult = {
  dataUrl: string;
  size: { w: number; h: number };
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

export async function normalizeImageToSquareDataUrl(src: string): Promise<SquareResult> {
  const input = String(src || '').trim();
  if (!input) return { dataUrl: '', size: { w: 0, h: 0 } };

  const img = new Image();
  const loaded = new Promise<void>((resolve) => {
    img.onload = () => resolve();
    img.onerror = () => resolve();
  });
  img.src = input;
  await loaded;

  const w = img.naturalWidth || 0;
  const h = img.naturalHeight || 0;
  const side = Math.max(w, h);
  if (!side) return { dataUrl: '', size: { w: 0, h: 0 } };

  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { dataUrl: '', size: { w: 0, h: 0 } };

  const scale = side / Math.max(w, h);
  const drawW = Math.max(1, Math.round(w * scale));
  const drawH = Math.max(1, Math.round(h * scale));
  const dx = Math.round((side - drawW) / 2);
  const dy = Math.round((side - drawH) / 2);

  ctx.clearRect(0, 0, side, side);
  ctx.drawImage(img, 0, 0, w, h, dx, dy, drawW, drawH);

  return { dataUrl: canvas.toDataURL('image/png'), size: { w: side, h: side } };
}

export async function normalizeFileToSquareDataUrl(file: File): Promise<SquareResult> {
  const raw = await readFileAsDataUrl(file);
  if (!raw) return { dataUrl: '', size: { w: 0, h: 0 } };
  return await normalizeImageToSquareDataUrl(raw);
}
