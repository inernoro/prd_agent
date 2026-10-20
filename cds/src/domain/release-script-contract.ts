/** Shared by the executor and dashboard: no project-specific deployment types. */
export const DEFAULT_RELEASE_SCRIPT_FILE = 'cds-release.sh';
export const DEFAULT_RELEASE_CI_WORKFLOW_FILE = 'ci.yml';
export const PROJECT_SCRIPT_MODE = 'project-script' as const;
export const MANAGED_SCRIPT_MODE = 'managed-script' as const;
