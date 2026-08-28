import { describe, expect, it } from 'vitest';
import { buildUploadProgress, fmtDuration } from './uploadProgress';

const MB = 1024 * 1024;

describe('上传等待期的「在做什么 + 还要多久」', () => {
  it('样本不足时不报 ETA —— 宁可说「正在测速」，也不编一个数', () => {
    // 刚发了 8KB、才过 100ms，此时算出来的速率毫无参考价值
    const v = buildUploadProgress(8 * 1024, 50 * MB, 100);
    expect(v.etaMs).toBeNull();
    expect(v.bytesPerSec).toBeNull();
    expect(v.detail).toContain('正在测速');
  });

  it('样本够了才报 ETA，且算的是剩余量除以实测速率', () => {
    // 2 秒发了 10MB → 5MB/s；还剩 40MB → 8 秒
    const v = buildUploadProgress(10 * MB, 50 * MB, 2000);
    expect(v.bytesPerSec).toBeCloseTo(5 * MB, -3);
    expect(v.etaMs).toBeCloseTo(8000, -2);
    expect(v.detail).toContain('8 秒');
  });

  it('字节发完之后不能再说「正在上传」—— 那一段是服务端在解包', () => {
    const v = buildUploadProgress(50 * MB, 50 * MB, 9000);
    expect(v.phase).toBe('processing');
    expect(v.title).not.toContain('正在上传');
    expect(v.title).toContain('解包');
  });

  it('解包阶段没有进度通道，只报已用时，不给百分比', () => {
    const v = buildUploadProgress(50 * MB, 50 * MB, 12000);
    expect(v.etaMs).toBeNull();
    expect(v.detail).toContain('已用时 12 秒');
    expect(v.detail).toContain('没有进度可报');
  });

  it('拿不到 total（lengthComputable=false）时走连接态，不报 0%', () => {
    const v = buildUploadProgress(0, 0, 500);
    expect(v.phase).toBe('connecting');
    expect(v.ratio).toBe(0);
    expect(v.title).not.toContain('0%');
  });

  it('ratio 不会超过 1（服务端多算几个字节也不能爆条）', () => {
    expect(buildUploadProgress(60 * MB, 50 * MB, 5000).ratio).toBe(1);
  });

  it('时长超过一分钟要换量纲，不写「95 秒」', () => {
    expect(fmtDuration(95_000)).toBe('1 分 35 秒');
    expect(fmtDuration(120_000)).toBe('2 分');
    expect(fmtDuration(45_000)).toBe('45 秒');
  });
});

describe('服务端解包那一段的分步清单', () => {
  const sent = (unpack?: Parameters<typeof buildUploadProgress>[3]) =>
    buildUploadProgress(50 * MB, 50 * MB, 9000, unpack);

  it('服务端报得出「第几个 / 共几个」就用真实比例，不再说「没有进度可报」', () => {
    const v = sent({ doneFiles: 1842, totalFiles: 2310, currentPath: 'assets/index-4f2a.js', currentSize: 190464 });
    expect(v.title).toContain('80%'); // 1842/2310 = 79.7%
    expect(v.detail).not.toContain('没有进度可报');
    expect(v.ratio).toBeCloseTo(1842 / 2310, 3);
  });

  it('三行清单逐字对齐设计稿，当前文件带路径与大小', () => {
    const v = sent({ doneFiles: 1842, totalFiles: 2310, entryFile: 'index.html', currentPath: 'assets/index-4f2a.js', currentSize: 190464 });
    expect(v.steps.map((s) => s.text)).toEqual([
      '已解包 1,842 / 2,310 个文件',
      '识别到入口文件 index.html',
      '正在上传第 1,843 个',
    ]);
    expect(v.steps[2].sub).toBe('assets/index-4f2a.js · 186 KB');
    expect(v.steps[2].state).toBe('active');
  });

  it('入口还没扫到就不写那一行——不预设 index.html', () => {
    const v = sent({ doneFiles: 10, totalFiles: 100, currentPath: 'a.js' });
    expect(v.steps.some((s) => s.text.includes('入口'))).toBe(false);
  });

  it('全部处理完之后不再显示「正在上传第 N 个」', () => {
    const v = sent({ doneFiles: 100, totalFiles: 100, entryFile: 'index.html', currentPath: 'z.js' });
    expect(v.steps.some((s) => s.state === 'active')).toBe(false);
  });

  it('拿不到服务端进度时清单为空，并退回诚实说法——不编一份假清单', () => {
    expect(sent().steps).toEqual([]);
    expect(sent().detail).toContain('没有进度可报');
    expect(sent({ doneFiles: 0, totalFiles: 0 }).steps).toEqual([]);
  });
});

describe('重传：拿不到上传进度事件时也要把界面推进去', () => {
  // 重传走的是不带 progress 事件的 fetch，loaded 恒为 0。只看 loaded >= total 的话，
  // 服务端明明已经在一个个吐文件名了，那一屏还停在「正在建立上传连接」——
  // 进度通道接上了，界面一个字都不显示，等于没接。
  it('服务端报出解包帧就进入处理中，哪怕 loaded 还是 0', () => {
    const v = buildUploadProgress(0, 1024 * 1024, 3000, {
      doneFiles: 3,
      totalFiles: 10,
      currentPath: 'assets/app.js',
    });
    expect(v.phase).toBe('processing');
    expect(v.steps.some((s) => s.text.includes('3'))).toBe(true);
  });

  it('只报出入口文件也算服务端已经开工', () => {
    const v = buildUploadProgress(0, 1024 * 1024, 1000, { entryFile: 'index.html' });
    expect(v.phase).toBe('processing');
  });

  it('没有任何解包信号时不许假装已经在处理', () => {
    // 边界：不能因为「有个 unpack 对象」就一律判处理中，否则真正的上传阶段被跳过。
    const v = buildUploadProgress(0, 1024 * 1024, 1000, null);
    expect(v.phase).not.toBe('processing');
    const empty = buildUploadProgress(0, 1024 * 1024, 1000, { doneFiles: 0, totalFiles: 0 });
    expect(empty.phase).not.toBe('processing');
  });
});
