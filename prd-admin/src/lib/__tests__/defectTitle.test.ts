import { describe, expect, it } from 'vitest';
import { extractDefectTitle, formatDefectTitle } from '../defectTitle';

describe('defectTitle', () => {
  it('removes markdown title labels and keeps the real title', () => {
    expect(extractDefectTitle('**缺陷标题：** 提交缺陷时未选择用户，点击提交按钮无响应')).toBe(
      '提交缺陷时未选择用户，点击提交按钮无响应'
    );
  });

  it('skips empty template section labels', () => {
    expect(
      extractDefectTitle(`**缺陷标题：**

**缺陷描述：**
页面切换时出现短暂空白`)
    ).toBe('页面切换时出现短暂空白');
  });

  it('skips screenshot noise before selecting a title', () => {
    expect(
      extractDefectTitle(`图1：https://i.map.ebcone.net/data/defect-agent/img/demo.png

提交缺陷时未选择用户，点击提交按钮无响应`)
    ).toBe('提交缺陷时未选择用户，点击提交按钮无响应');
  });

  it('uses content fallback when persisted title is invalid', () => {
    expect(formatDefectTitle('图1', '点击提示词跳转到首页去了')).toBe('点击提示词跳转到首页去了');
  });
});
