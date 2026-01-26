import {
  formatRelativeTime,
  formatDuration,
  getTimestamp,
} from '../../src/utils/timeUtils.js';

describe('timeUtils', () => {
  describe('formatRelativeTime', () => {
    it('should return "刚刚" for very recent times', () => {
      const now = new Date();
      expect(formatRelativeTime(now)).toBe('刚刚');
    });

    it('should return minutes for times less than an hour ago', () => {
      const date = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
      expect(formatRelativeTime(date)).toBe('30分钟前');
    });

    it('should return hours for times less than a day ago', () => {
      const date = new Date(Date.now() - 5 * 60 * 60 * 1000); // 5 hours ago
      expect(formatRelativeTime(date)).toBe('5小时前');
    });

    it('should return days for times less than a week ago', () => {
      const date = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
      expect(formatRelativeTime(date)).toBe('3天前');
    });

    it('should return weeks for times less than a month ago', () => {
      const date = new Date(Date.now() - 2 * 7 * 24 * 60 * 60 * 1000); // 2 weeks ago
      expect(formatRelativeTime(date)).toBe('2周前');
    });

    it('should return months for older times', () => {
      const date = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // ~2 months ago
      expect(formatRelativeTime(date)).toBe('2个月前');
    });

    it('should handle string dates', () => {
      const now = new Date();
      expect(formatRelativeTime(now.toISOString())).toBe('刚刚');
    });

    it('should handle timestamp numbers', () => {
      const now = Date.now();
      expect(formatRelativeTime(now)).toBe('刚刚');
    });
  });

  describe('formatDuration', () => {
    it('should format milliseconds', () => {
      expect(formatDuration(500)).toBe('500ms');
    });

    it('should format seconds', () => {
      expect(formatDuration(5000)).toBe('5秒');
    });

    it('should format minutes and seconds', () => {
      expect(formatDuration(125000)).toBe('2分 5秒');
    });

    it('should format hours and minutes', () => {
      expect(formatDuration(3725000)).toBe('1小时 2分钟');
    });

    it('should format days and hours', () => {
      expect(formatDuration(90000000)).toBe('1天 1小时');
    });

    it('should handle zero', () => {
      expect(formatDuration(0)).toBe('0ms');
    });
  });

  describe('getTimestamp', () => {
    it('should return ISO timestamp', () => {
      const timestamp = getTimestamp();
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should be parseable as date', () => {
      const timestamp = getTimestamp();
      const date = new Date(timestamp);
      expect(date.getTime()).not.toBeNaN();
    });
  });
});
