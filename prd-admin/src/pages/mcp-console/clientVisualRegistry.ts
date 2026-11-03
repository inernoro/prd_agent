import { Asterisk, Bot, Network, Plug, SquareTerminal, type LucideIcon } from 'lucide-react';

interface ClientVisual {
  match: RegExp;
  icon: LucideIcon;
  text: string;
  soft: string;
}

/** Visual hint from the editable name, never a claim about protocol or online status. */
const CLIENT_VISUAL_REGISTRY: ClientVisual[] = [
  { match: /codex/i, icon: SquareTerminal, text: 'var(--semantic-info-text)', soft: 'var(--semantic-info-soft)' },
  { match: /claude/i, icon: Asterisk, text: 'var(--semantic-orange-text)', soft: 'var(--semantic-orange-soft)' },
  { match: /workbuddy/i, icon: Bot, text: 'var(--semantic-success-text)', soft: 'var(--semantic-success-soft)' },
  { match: /cds|转发|bridge/i, icon: Network, text: 'var(--semantic-cyan-text)', soft: 'var(--semantic-cyan-soft)' },
];
const FALLBACK = { icon: Plug, text: 'var(--text-secondary)', soft: 'var(--bg-sunken)' };

export function clientVisual(name: string) {
  return CLIENT_VISUAL_REGISTRY.find(item => item.match.test(name)) ?? FALLBACK;
}
