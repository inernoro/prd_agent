type TitledEntry = {
  id: string;
  title: string;
  isFolder: boolean;
  hasWritingPublication?: boolean;
};

export function documentDisplayTitle(entry: TitledEntry, useContentTitle: boolean, contentTitles: ReadonlyMap<string, string>): string {
  // 成文条目的 summary 是派生概述，不能代替作者确认的发布标题。
  if (entry.isFolder || entry.hasWritingPublication || !useContentTitle) return entry.title;
  return contentTitles.get(entry.id) || entry.title;
}
