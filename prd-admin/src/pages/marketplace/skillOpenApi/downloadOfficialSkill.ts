import { api } from '@/services/api';

/**
 * 官方技能包 key（平台内置）。
 * 和后端 OfficialSkillTemplates.FindMapSkillsKey 保持一致。
 *
 * findmapskills = 海鲜市场操作技能（一个技能覆盖搜索 / 下载 / 上传 / 订阅）。
 */
export const OFFICIAL_SKILL_FINDMAPSKILLS = 'findmapskills';

/**
 * 官方技能包直链 —— 给"复制给智能体"的提示词用，AI 会用 curl 下载。
 * 在浏览器里不走这个 helper，走下面的 fetch+blob。
 */
export function resolveOfficialSkillDownloadUrl(
  skillKey: string = OFFICIAL_SKILL_FINDMAPSKILLS,
  origin?: string,
): string {
  const base = (origin ?? (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/+$/, '');
  return `${base}${api.officialSkills.download(encodeURIComponent(skillKey))}`;
}

/**
 * 下载平台官方技能包 zip，浏览器自动存盘。
 *
 * - 后端端点：`GET /api/official-skills/{skillKey}/download`（匿名可访问）
 * - 走 fetch + blob —— 不用 `a.href=url` 是因为官方技能包的 URL 在某些反代下没有
 *   `Content-Disposition`，直接点会打开预览而不是下载。
 */
export async function downloadOfficialSkill(skillKey: string = OFFICIAL_SKILL_FINDMAPSKILLS): Promise<void> {
  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const path = api.officialSkills.download(encodeURIComponent(skillKey));
  const url = rawBase ? `${rawBase}${path}` : path;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      // 让后端知道 base URL，SKILL.md 的 {{BASE_URL}} 占位符会替换为这个值
      'X-Client-Base-Url': window.location.origin,
    },
  });
  if (!res.ok) {
    throw new Error(`下载失败（HTTP ${res.status}）`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = `${skillKey}.zip`;
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    // 给浏览器一点时间触发下载，再释放
    setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
  }
}

/** 首次下载标记 —— sessionStorage；用户清缓存或换标签页会重置 */
const FIRST_DOWNLOAD_KEY = 'skill-openapi-first-downloaded';

export function hasDownloadedOfficialSkill(): boolean {
  try {
    return sessionStorage.getItem(FIRST_DOWNLOAD_KEY) === '1';
  } catch {
    return false;
  }
}

export function markOfficialSkillDownloaded(): void {
  try {
    sessionStorage.setItem(FIRST_DOWNLOAD_KEY, '1');
  } catch {
    /* ignore quota errors */
  }
}
