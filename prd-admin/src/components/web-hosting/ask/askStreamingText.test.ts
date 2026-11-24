import { describe, expect, it } from 'vitest';
import { askStreamingText } from './askStreamingText';

describe('流式引用协议的展示过滤', () => {
  it('连续标记不泄漏，不提前构造未经服务端验证的脚注', () => {
    expect(askStreamingText('结论[引用:1][引用:99]。')).toBe('结论。');
    expect(askStreamingText('结论[引用:无效编号]。')).toBe('结论。');
  });
  it.each(['[', '[引', '[引用', '[引用:', '[引用:123'])('半截协议标记暂不展示：%s', (part) => {
    expect(askStreamingText(`结论${part}`)).toBe('结论');
  });
  it('不吞掉普通 Markdown 链接、代码和后续正文', () => {
    const normal = '[来源](https://example.com) 与 `value[0]`、[普通说明]';
    expect(askStreamingText(normal)).toBe(normal);
    expect(askStreamingText('前文[引用:1]后文')).toBe('前文后文');
    expect(askStreamingText('结论[引用:未完\n下一行')).toBe('结论[引用:未完\n下一行');
  });
});
