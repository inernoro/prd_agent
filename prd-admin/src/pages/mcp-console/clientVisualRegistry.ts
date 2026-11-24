import { Asterisk, Bot, Network, Plug, SquareTerminal, type LucideIcon } from 'lucide-react';

interface ClientVisual {
  match: RegExp;
  icon: LucideIcon;
  text: string;
  soft: string;
}

/** Visual hint from the editable name, never a claim about protocol or online status. */
const CLIENT_VISUAL_REGISTRY: ClientVisual[] = [
  { match: /codex/i, icon: SquareTerminal, text: 'var(--text-secondary)', soft: 'var(--bg-sunken)' },
  { match: /claude/i, icon: Asterisk, text: 'var(--text-secondary)', soft: 'var(--bg-sunken)' },
  { match: /workbuddy/i, icon: Bot, text: 'var(--text-secondary)', soft: 'var(--bg-sunken)' },
  { match: /cds|转发|bridge/i, icon: Network, text: 'var(--text-secondary)', soft: 'var(--bg-sunken)' },
];
const FALLBACK = { icon: Plug, text: 'var(--text-secondary)', soft: 'var(--bg-sunken)' };

export function clientVisual(name: string) {
  return CLIENT_VISUAL_REGISTRY.find(item => item.match.test(name)) ?? FALLBACK;
}
