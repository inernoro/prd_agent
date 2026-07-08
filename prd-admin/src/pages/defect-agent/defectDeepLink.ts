export function getDefectDeepLinkId(searchParams: URLSearchParams): string | null {
  return searchParams.get('defectId') || searchParams.get('id');
}

export function clearDefectDeepLinkParams(searchParams: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  next.delete('defectId');
  next.delete('id');
  return next;
}
