import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { createImageGalleryZip, isGallerySelection, renderGalleryHtml } from './imageGalleryUpload';

describe('image gallery upload', () => {
  it('only bundles multiple supported image files', () => {
    const image = (name: string) => new File(['image'], name);
    expect(isGallerySelection([image('one.png'), image('two.webp')])).toBe(true);
    expect(isGallerySelection([image('one.png')])).toBe(false);
    expect(isGallerySelection([image('one.png'), image('two.txt')])).toBe(false);
  });

  it('escapes names and keeps images as separate gallery items', () => {
    const html = renderGalleryHtml([
      { name: '<first>.png', path: 'images/image-01.png' },
      { name: 'second.jpg', path: 'images/image-02.jpg' },
    ]);
    expect(html).toContain('alt="&lt;first&gt;.png"');
    expect(html).toContain('src="images/image-02.jpg"');
    expect(html).not.toContain('<first>');
    expect(html.match(/<figure>/g)).toHaveLength(2);
  });

  it('builds a real website zip with both images', async () => {
    const bundle = await createImageGalleryZip([
      new File(['first'], 'one.png', { type: 'image/png' }),
      new File(['second'], 'two.jpg', { type: 'image/jpeg' }),
    ]);
    const zip = await JSZip.loadAsync(await bundle.arrayBuffer());
    expect(await zip.file('images/image-01.png')?.async('string')).toBe('first');
    expect(await zip.file('images/image-02.jpg')?.async('string')).toBe('second');
    expect(await zip.file('index.html')?.async('string')).toContain('图片画廊');
  });
});
