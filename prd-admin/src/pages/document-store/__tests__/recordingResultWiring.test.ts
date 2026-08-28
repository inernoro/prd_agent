/**
 * 录音结果页「真的能打开、且打开后是完整的」两条接线守卫。
 *
 * 这两条都是被真实页面取证抓出来的，而不是被测试抓出来的——它们的共同特征是
 * **删掉不会红**：编译过、类型对、路由能进、全量测试全绿，只有真的打开那一屏
 * 才看得出来（predicate-and-wiring-discipline 形状 2）。
 *
 *   1. 路由缺 `placement: 'fullscreen'` → 条目按默认挂进 AppShell，
 *      稿面那张「自带顶栏的独立整屏」外面套上了平台顶栏与底部 TabBar。
 *   2. 页面一个回调都不传 → 一键整理、逐句校对、词典、改说话人、重新生成
 *      整块静默消失。组件按设计「没有回调就不渲染那一块」，所以不报错。
 *
 * 断言的是**接线这件事本身**，不逐字比对样式（形状 4a：别把某段实现的字面存在锁死）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..', '..');
const PAGE = fs.readFileSync(path.resolve(HERE, '..', 'RecordingResultPage.tsx'), 'utf8');
const REGISTRY = fs.readFileSync(path.resolve(SRC, 'app', 'navRegistry.tsx'), 'utf8');

describe('录音结果页挂在全屏层，不是平台外壳里', () => {
  it('路由条目声明了 placement: fullscreen', () => {
    const start = REGISTRY.indexOf("path: '/document-store/:storeId/recording/:entryId'");
    expect(start, 'navRegistry 里找不到录音结果页路由').toBeGreaterThanOrEqual(0);
    // 只看这一条条目的范围内有没有声明，避免匹配到别的条目的 placement
    const entry = REGISTRY.slice(start, REGISTRY.indexOf('\n  },', start));
    expect(entry).toContain("placement: 'fullscreen'");
  });
});

describe('结果页把回调接给了跟读组件（不接就整块消失）', () => {
  const karaoke = PAGE.slice(PAGE.indexOf('<TranscriptKaraoke'));

  it.each([
    ['onSaveNote', '逐句校对 / 词典 / 改说话人'],
    ['onRestyle', '会议纪要标题右侧的「重新生成」'],
    ['organize', '一键整理四张卡的状态'],
    ['onPickOrganizeStyle', '一键整理这一整块'],
  ])('传了 %s（缺了就没有：%s）', (prop) => {
    expect(karaoke).toContain(`${prop}=`);
  });

  it('保存写的是转录笔记条目，不是音频条目', () => {
    expect(PAGE).toContain('updateDocumentContent(state.noteId');
  });

  it('整理是发起真实 run 并轮询到终态，不是点完就当它成了', () => {
    expect(PAGE).toContain('transcribeEntry(entryId');
    // 认「拿在途 run 的 id 去查」这件事，不认它此刻叫 running.runId 还是 runningRunId——
    // 钉逐字写法的话，把依赖从对象改成 id（修那次轮询连发）就会让这条无辜变红
    expect(PAGE).toMatch(/getAgentRun\(running/);
    expect(PAGE).toMatch(/run\.status === 'done'/);
  });
});
