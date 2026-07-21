import { describe, expect, it } from 'vitest';
import { parseMeetingContext } from './transcribeStyleContext';

describe('parseMeetingContext', () => {
  it('从评审邀请中识别方案字段和被提及人员', () => {
    const fields = parseMeetingContext(`【方案评审邀请通知】
评审方案：米多星球T3.13.7(客户企业主体核验管理)AI文档 1-3稿
会议地点：会议室
会议时间：2026.7.15 下午 4:00 - 5:00
方案地址：https://miduo1031.yuque.com/example

@张知智  @潘洪玉  @余瑞鹏`);

    expect(Object.fromEntries(fields.map(field => [field.label, field.value]))).toEqual({
      评审方案: '米多星球T3.13.7(客户企业主体核验管理)AI文档 1-3稿',
      会议地点: '会议室',
      会议时间: '2026.7.15 下午 4:00 - 5:00',
      方案地址: 'https://miduo1031.yuque.com/example',
      参与人员: '张知智、潘洪玉、余瑞鹏',
    });
  });
});
