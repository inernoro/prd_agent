export type StateBootstrapMode = 'fresh' | 'migrate';

const VALID_BOOTSTRAP_MODES: readonly StateBootstrapMode[] = ['fresh', 'migrate'];

export function resolveStateBootstrapMode(raw: string | undefined): StateBootstrapMode {
  const mode = (raw || 'fresh').trim().toLowerCase();
  if ((VALID_BOOTSTRAP_MODES as readonly string[]).includes(mode)) {
    return mode as StateBootstrapMode;
  }
  throw new Error(
    `Unknown CDS_STATE_BOOTSTRAP_MODE '${raw}'. Valid values: 'fresh' | 'migrate'.`,
  );
}

export function shouldSeedStateFromJson(mode: StateBootstrapMode): boolean {
  return mode === 'migrate';
}

export interface StateBootstrapTarget<TState> {
  load(): TState | null;
  seedIfEmpty(state: TState): Promise<boolean | void>;
}

export interface StateBootstrapSource<TState> {
  load(): TState | null;
}

export type StateBootstrapSeedResult = 'target-not-empty' | 'no-json-state' | 'seeded' | 'skipped';

export async function seedStateFromJsonIfAllowed<TState>(
  mode: StateBootstrapMode,
  target: StateBootstrapTarget<TState>,
  source: StateBootstrapSource<TState>,
): Promise<StateBootstrapSeedResult> {
  if (target.load() !== null) return 'target-not-empty';

  const existing = source.load();
  if (!existing) return 'no-json-state';

  if (!shouldSeedStateFromJson(mode)) return 'skipped';

  await target.seedIfEmpty(existing);
  return 'seeded';
}
