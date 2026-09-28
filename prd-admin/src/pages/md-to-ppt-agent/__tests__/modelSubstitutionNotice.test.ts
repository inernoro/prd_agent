import { describe, expect, it } from 'vitest';
import { noticeFromModelSubstitution } from '../MdToPptAgentPage';

describe('noticeFromModelSubstitution', () => {
  it('surfaces the server notice when the default profile model was replaced by the gateway default', () => {
    const message = '默认运行配置里的模型「gpt-5.6-sol」不在 LLM Gateway 的对外模型目录里，本次改用网关为 MD 转 PPT 配置的默认对外模型 default-chat-curated（gpt-5.6-sol）生成页面。';
    expect(noticeFromModelSubstitution({ stage: 'model_substituted', message })).toBe(message);
  });

  it('ignores other diagnostic stages and empty messages', () => {
    expect(noticeFromModelSubstitution({ stage: 'page_start', message: 'x' })).toBeNull();
    expect(noticeFromModelSubstitution({ stage: 'model_substituted', message: '  ' })).toBeNull();
    expect(noticeFromModelSubstitution({ stage: 'model_substituted' })).toBeNull();
  });
});
