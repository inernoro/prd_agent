import { describe, expect, it } from 'vitest';
import { buildInlineImageToken } from '@/lib/visualAgentPromptUtils';
import { createVisualAgentHandoffPayload, parseVisualAgentHandoff } from '@/lib/visualAgentHandoff';

describe('visual agent 首页交接包', () => {
  it('data URL 不进入消息标记，但必须作为独立参考图到达画板', () => {
    const src = 'data:image/png;base64,AAAA';
    expect(buildInlineImageToken(src, '参考图.png')).toBe('');

    const payload = createVisualAgentHandoffPayload({
      prompt: '重新设计一版',
      size: '1024x1024',
      modelId: 'pool_future-model-2099',
      imageSize: { w: 320, h: 240 },
      inlineImage: { src, name: '参考图.png' },
      timestamp: 1,
    });
    const parsed = parseVisualAgentHandoff(JSON.stringify(payload));

    expect(payload.messageText).not.toContain(src);
    expect(parsed).toMatchObject({
      prompt: {
        text: '重新设计一版',
        size: '1024x1024',
        inlineImage: { src, name: '参考图.png' },
      },
      modelId: 'pool_future-model-2099',
      imageSize: { w: 320, h: 240 },
    });
  });

  it('继续读取旧交接包中的远程图片标记', () => {
    const token = buildInlineImageToken('https://example.test/ref.png', '旧参考图.png');
    const parsed = parseVisualAgentHandoff(JSON.stringify({
      messageText: `${token}(@size:1024x1024) 调整布局`,
      assetId: null,
      modelId: 'pool_image1',
    }));

    expect(parsed?.prompt).toMatchObject({
      text: '调整布局',
      size: '1024x1024',
      inlineImage: { src: 'https://example.test/ref.png', name: '旧参考图.png' },
    });
  });
});
