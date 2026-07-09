import { describe, expect, it } from 'vitest';
import { getNotificationType, isEscalationNotification } from '../notificationTypeRegistry';

describe('notificationTypeRegistry', () => {
  describe('isEscalationNotification', () => {
    it('flags已下线的催办/超时提醒来源', () => {
      expect(isEscalationNotification({ source: 'defect-escalation', key: null, title: '' })).toBe(true);
      expect(isEscalationNotification({ source: 'defect-reminder', key: null, title: '' })).toBe(true);
      expect(isEscalationNotification({ source: 'pm-reminder', key: null, title: '' })).toBe(true);
    });

    it('flags按 key 前缀或标题命中的催办', () => {
      expect(isEscalationNotification({ source: 'defect-agent', key: 'defect-escalation:x', title: '' })).toBe(true);
      expect(isEscalationNotification({ source: 'defect-agent', key: null, title: '缺陷催办：DEF-1' })).toBe(true);
    });

    it('flags仅正文透出催办语义的残留（与后端口径对齐）', () => {
      expect(isEscalationNotification({ source: 'defect-agent', key: null, title: '缺陷进展', message: '请尽快跟进该缺陷' })).toBe(true);
      expect(isEscalationNotification({ source: 'defect-agent', key: null, title: '缺陷进展', message: '该缺陷已超时仍未处理' })).toBe(true);
    });

    it('放行正常缺陷/系统通知', () => {
      expect(isEscalationNotification({ source: 'defect-agent', key: 'defect-resolved:x', title: '缺陷已解决，待你验收', message: '请前往验收' })).toBe(false);
      expect(isEscalationNotification({ source: 'report-agent', key: null, title: '本周周报已生成', message: '超时未提交' })).toBe(false);
    });
  });

  describe('getNotificationType', () => {
    it('按 source 命中对应类型', () => {
      expect(getNotificationType({ source: 'defect-agent', level: 'info', title: '' }).label).toBe('缺陷协作');
      expect(getNotificationType({ source: 'report-agent', level: 'info', title: '' }).label).toBe('周报月报');
      expect(getNotificationType({ source: 'system-alert', level: 'warning', title: '' }).popupStyle).toBe('alert');
    });

    it('缺陷解决(success)走庆祝气质', () => {
      const v = getNotificationType({ source: 'defect-agent', level: 'success', title: '缺陷已解决，待你验收' });
      expect(v.popupStyle).toBe('celebrate');
      expect(v.key).toBe('defect-agent');
    });

    it('未注册来源按 level 兜底', () => {
      expect(getNotificationType({ source: 'unknown-x', level: 'error', title: '' }).popupStyle).toBe('alert');
      expect(getNotificationType({ source: null, level: 'info', title: '' }).label).toBe('通知');
    });
  });
});
