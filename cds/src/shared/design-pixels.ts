export async function designPixelDifference({ before, after }: { before: string; after: string }) {
  const images = {
    async load(src: string) {
      const image = new Image();
      image.src = src;
      await image.decode();
      return image;
    },
  };
  const [left, right] = await Promise.all([images.load(before), images.load(after)]);
  const { naturalWidth: width, naturalHeight: height } = right;
  if (left.naturalWidth !== width || left.naturalHeight !== height) throw new Error('Screenshot size differs');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Pixel comparison unavailable');
  context.drawImage(left, 0, 0);
  const base = context.getImageData(0, 0, width, height).data;
  context.clearRect(0, 0, width, height);
  context.drawImage(right, 0, 0);
  const next = context.getImageData(0, 0, width, height).data;
  const tileSize = 32, columns = Math.ceil(width / tileSize);
  const tiles = new Set<number>();
  let count = 0;
  for (let offset = 0; offset < next.length; offset += 4) {
    if (base[offset] === next[offset] && base[offset + 1] === next[offset + 1]
      && base[offset + 2] === next[offset + 2] && base[offset + 3] === next[offset + 3]) continue;
    const index = offset / 4;
    const column = Math.floor((index % width) / tileSize);
    const row = Math.floor(index / width / tileSize);
    tiles.add(row * columns + column);
    count++;
  }
  const boxes = [...tiles].map(index => {
    const x = (index % columns) * tileSize, y = Math.floor(index / columns) * tileSize;
    return { id: String(index), stamp: 0, tone: 'changed' as const, x: x / width, y: y / height,
      width: Math.min(tileSize, width - x) / width, height: Math.min(tileSize, height - y) / height };
  });
  return { boxes, area: count / (width * height) * 100 };
}
