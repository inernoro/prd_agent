import designPreviewContract from '../shared/design-preview-contract.json' with { type: 'json' };

export const designPrototypeCsp = designPreviewContract.csp.join('; ');
const prototypeBridge = `<script data-entry-timeout="${designPreviewContract.entryTimeoutMs}">
${designPreviewContract.bridge.join('\n')}
</script>`;

export function decorateDesignPrototype(html: string): string {
  const head = html.match(/<head(?:\s[^>]*)?>/i);
  const index = head ? head.index! + head[0].length : 0;
  return index > 0 ? html.slice(0, index) + prototypeBridge + html.slice(index)
    : html.replace(/^(<!doctype[^>]+>\s*)?/i, start => start + prototypeBridge);
}
