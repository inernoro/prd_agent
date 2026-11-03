import type { ProductInitiation, ProductRelease } from './types';

const compact = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();

/** 搜索含版本号的完整文档名时使用应用+版本号，标题正文/稿次不再参与定位。 */
export function matchesVersionRecord(item: ProductInitiation | ProductRelease, query: string, status: string,
  productName = '', aliases: Readonly<Record<string, string>> = {}) {
  if (status && item.status !== status) return false;
  const keyword = compact(query.trim());
  if (!keyword) return true;
  const code = /[tv]\d+\.\d+\.\d+/i.exec(keyword);
  if (code) {
    const recordCode = 'vCode' in item ? item.vCode : item.tCode;
    if (compact(recordCode ?? '') !== code[0]) return false;
    const canonical = (name: string) => {
      const normalized = compact(name);
      const alias = Object.entries(aliases).find(([key]) => compact(key) === normalized);
      return compact(alias?.[1] ?? name);
    };
    const application = keyword.slice(0, code.index);
    if (!application) return true;
    return [item.appName, productName, item.systemName, `${item.systemName ?? ''}${item.appName ?? ''}`]
      .some(name => name && canonical(name) === canonical(application));
  }
  return Object.values(item).some(value => {
    if (value == null || typeof value === 'object' && !Array.isArray(value)) return false;
    return (Array.isArray(value) ? value : [value]).some(entry => compact(String(entry)).includes(keyword));
  });
}
