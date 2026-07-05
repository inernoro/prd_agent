import { describe, it, expect } from 'vitest';
import { parseLiveNodePreview } from '../liveNodePreview';

/**
 * 流式 JSON 增量解析器守卫测试：
 * 占位卡的「产物即体验」渲染依赖它把任意截断点的 LLM 原文解析成节点卡形状，
 * 任何截断点都不允许抛错，解析不出内容时必须干净地退化（hasAny=false → shimmer）。
 */
describe('parseLiveNodePreview', () => {
  it('空输入 / 纯围栏前缀 → 无内容，退化 shimmer', () => {
    expect(parseLiveNodePreview('').hasAny).toBe(false);
    expect(parseLiveNodePreview(undefined).hasAny).toBe(false);
    expect(parseLiveNodePreview('```json\n[').hasAny).toBe(false);
    expect(parseLiveNodePreview('[{').hasAny).toBe(false);
  });

  it('标题打字中：截断在字符串中间也能取出已有文字', () => {
    const p = parseLiveNodePreview('```json\n[{\n  "title": "PPT 自动排');
    expect(p.hasAny).toBe(true);
    expect(p.draft?.title).toBe('PPT 自动排');
    expect(p.draft?.titleDone).toBe(false);
    expect(p.doneTitles).toEqual([]);
  });

  it('标题闭合 + 描述打字中：光标语义正确', () => {
    const p = parseLiveNodePreview('[{"title": "规则冲突检测", "description": "自动识别项目上下文，按');
    expect(p.draft?.title).toBe('规则冲突检测');
    expect(p.draft?.titleDone).toBe(true);
    expect(p.draft?.description).toBe('自动识别项目上下文，按');
    expect(p.draft?.descriptionDone).toBe(false);
  });

  it('长字段流式中：映射为中文标签的次要信息', () => {
    const p = parseLiveNodePreview(
      '[{"title": "A", "description": "B", "groundingContent": "源自种子文档：\'4.2 Rules 的分层',
    );
    expect(p.draft?.descriptionDone).toBe(true);
    expect(p.draft?.activeField?.label).toBe('现实锚点');
    expect(p.draft?.activeField?.text).toContain('4.2 Rules 的分层');
  });

  it('评分与标签解析到即显示', () => {
    const p = parseLiveNodePreview(
      '[{"title": "A", "description": "B", "valueScore": 4, "difficultyScore": 2, "tags": ["工程化", "规则"]',
    );
    expect(p.draft?.valueScore).toBe(4);
    expect(p.draft?.difficultyScore).toBe(2);
    expect(p.draft?.tags).toEqual(['工程化', '规则']);
  });

  it('数组内字符串打字中（tags 流到一半）不误判为直连字段', () => {
    const p = parseLiveNodePreview('[{"title": "A", "tags": ["工程');
    expect(p.draft?.title).toBe('A');
    expect(p.draft?.titleDone).toBe(true);
    expect(p.draft?.activeField?.label).toBe('标签');
    expect(p.draft?.activeField?.text).toBe('工程');
  });

  it('首个对象闭合 + 第二个生成中：已完成标题进入 doneTitles', () => {
    const p = parseLiveNodePreview(
      '[{"title": "规则分层器", "description": "X", "valueScore": 4, "difficultyScore": 2, "tags": []},'
      + '\n{"title": "AGENTS.md 生',
    );
    expect(p.doneTitles).toEqual(['规则分层器']);
    expect(p.draft?.title).toBe('AGENTS.md 生');
    expect(p.draft?.titleDone).toBe(false);
  });

  it('对象之间的空档：draft 为 null 但 hasAny 仍为 true', () => {
    const p = parseLiveNodePreview('[{"title": "规则分层器", "description": "X"},');
    expect(p.doneTitles).toEqual(['规则分层器']);
    expect(p.draft).toBeNull();
    expect(p.hasAny).toBe(true);
  });

  it('转义字符：闭合字段正确还原，结尾悬挂反斜杠不抛错', () => {
    const p = parseLiveNodePreview('[{"title": "带\\"引号\\"名", "description": "换\\n行\\');
    expect(p.draft?.title).toBe('带"引号"名');
    expect(p.draft?.description).toBe('换\n行');
  });

  it('字符串里出现大括号不干扰对象切分', () => {
    const p = parseLiveNodePreview('[{"title": "含 {花括号} 的标题", "description": "x"}, {"title": "下一个');
    expect(p.doneTitles).toEqual(['含 {花括号} 的标题']);
    expect(p.draft?.title).toBe('下一个');
  });

  it('groundingType 枚举值不作为次要信息展示', () => {
    const p = parseLiveNodePreview('[{"title": "A", "description": "B", "groundingType": "docum');
    expect(p.draft?.activeField).toBeUndefined();
  });
});
