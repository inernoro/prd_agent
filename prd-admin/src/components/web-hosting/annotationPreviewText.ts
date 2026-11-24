/** Bound automatic previews; the complete comment stays available on demand. */
export function annotationPreviewText(text: string, limit = 280): string {
  return text.length <= limit ? text : text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '') + '…';
}
