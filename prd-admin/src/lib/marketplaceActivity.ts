import { formatDate } from './dateUtils';

const DAY = 24 * 60 * 60 * 1000;
/** 沿用热门排序的下载次数口径；固定门槛使个人列表和搜索结果保持一致。 */
export const MARKETPLACE_HOT_DOWNLOADS = 10;

function timestamp(value?: string): number {
  return value ? Date.parse(value) : NaN;
}

export function isNewMarketplaceUpload(createdAt: string, now = Date.now()): boolean {
  const elapsed = now - timestamp(createdAt);
  return elapsed >= 0 && elapsed < 7 * DAY;
}

export function marketplaceReleaseTime(createdAt: string, updatedAt?: string, now = Date.now()) {
  const created = timestamp(createdAt);
  const updated = timestamp(updatedAt);
  const hasUpdate = Number.isFinite(updated) && (!Number.isFinite(created) || updated > created);
  const value = hasUpdate ? updatedAt! : createdAt;
  const time = timestamp(value);
  if (!Number.isFinite(time)) return null;

  const elapsed = now - time;
  const action = hasUpdate ? '更新' : '上传';
  let text: string;
  if (elapsed < 0 || elapsed >= 30 * DAY) text = formatDate(value, 'YYYY-MM-DD');
  else if (elapsed < 60_000) text = `刚刚${action}`;
  else if (elapsed < 3_600_000) text = `${Math.floor(elapsed / 60_000)} 分钟前${action}`;
  else if (elapsed < DAY) text = `${Math.floor(elapsed / 3_600_000)} 小时前${action}`;
  else if (elapsed < 7 * DAY) text = `${Math.floor(elapsed / DAY)} 天前${action}`;
  else text = `${Math.floor(elapsed / (7 * DAY))} 周前${action}`;

  const details = [
    Number.isFinite(created) ? `上传时间：${formatDate(createdAt)}` : '',
    hasUpdate ? `更新时间：${formatDate(value)}` : '',
  ].filter(Boolean).join('；');
  return { dateTime: value, text, title: details };
}
