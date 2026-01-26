/**
 * Format a date to relative time string
 * @param {Date|string|number} date - The date to format
 * @returns {string} Relative time string
 */
export function formatRelativeTime(date) {
  const now = new Date();
  const target = new Date(date);
  const diffMs = now - target;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffWeek = Math.floor(diffDay / 7);
  const diffMonth = Math.floor(diffDay / 30);

  if (diffSec < 60) {
    return '刚刚';
  } else if (diffMin < 60) {
    return `${diffMin}分钟前`;
  } else if (diffHour < 24) {
    return `${diffHour}小时前`;
  } else if (diffDay < 7) {
    return `${diffDay}天前`;
  } else if (diffWeek < 4) {
    return `${diffWeek}周前`;
  } else if (diffMonth < 12) {
    return `${diffMonth}个月前`;
  } else {
    return target.toLocaleDateString('zh-CN');
  }
}

/**
 * Format duration in milliseconds to human readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Human readable duration
 */
export function formatDuration(ms) {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    return `${days}天 ${remainingHours}小时`;
  } else if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}小时 ${remainingMinutes}分钟`;
  } else if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}分 ${remainingSeconds}秒`;
  } else {
    return `${seconds}秒`;
  }
}

/**
 * Get ISO timestamp
 * @returns {string} ISO timestamp
 */
export function getTimestamp() {
  return new Date().toISOString();
}
