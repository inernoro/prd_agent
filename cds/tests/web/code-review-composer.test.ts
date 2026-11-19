import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewComposer } from '../../web/src/pages/code-reviews/ReviewComposer';
import { ReviewUserKeyOptions, type UserKeyOptions } from '../../web/src/pages/code-reviews/ReviewUserKeyOptions';

const renderKey = (value: UserKeyOptions | null, configured = true) => renderToStaticMarkup(createElement(ReviewUserKeyOptions, { value, configured, onChange: () => {} }));
const key: UserKeyOptions = { provider: 'openai', model: 'gpt-6.2-sol', apiKey: '', tokenLimit: 200000 };

describe('代码审查配置体验', () => {
  it('常见模型和用量以可选项展示，说明额度不足会停止', () => {
    const html = renderKey(key);
    expect(html).toContain('<select');
    expect(html).toContain('gpt-6.2-sol（默认）');
    expect(html).not.toContain('gpt-4.1-mini');
    expect(html).toContain('20 万 Token（默认）');
    expect(html).toContain('剩余额度不足时停止');
    expect(html).toContain('不是金额或账户余额');
    expect(html).not.toContain('type="number"');
  });
  it('保留未列出的模型和非预设额度，避免丢失已有自定义选择', () => {
    const html = renderKey({ ...key, model: 'private/new-model', tokenLimit: 30000 });
    expect(html).toContain('value="private/new-model"');
    expect(html).toContain('value="30000"');
    expect(html).toContain('自定义模型名称');
    expect(html).toContain('max="10000000"');
  });
  it('使用平台模型时无需密钥；未配置个人密钥功能时选项不可用', () => {
    const html = renderKey(null, false);
    expect(html).not.toContain('type="password"');
    expect(html).toContain('<option value="user" disabled="">');
  });
  it('配置常驻右栏并位于提交操作之前，导入报告不显示审查配置', () => {
    const props = { projects: [], projectId: '', capabilities: null, onBack: () => {}, onSaved: () => {} };
    const source = renderToStaticMarkup(createElement(ReviewComposer, { ...props, mode: 'source' }));
    expect(source).toContain('aria-label="本次审查配置"');
    expect(source.indexOf('模型使用方式')).toBeLessThan(source.indexOf('下一步：确认'));
    expect(source).not.toContain('更多选项');
    const imported = renderToStaticMarkup(createElement(ReviewComposer, { ...props, mode: 'import' }));
    expect(imported).not.toContain('模型使用方式');
    expect(imported).toContain('原文件预览');
  });
});
