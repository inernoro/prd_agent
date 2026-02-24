import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

export function formatDistanceToNow(date: Date | string): string {
  return dayjs(date).fromNow();
}

export function formatDate(date: Date | string, format = 'YYYY-MM-DD HH:mm'): string {
  return dayjs(date).format(format);
}
