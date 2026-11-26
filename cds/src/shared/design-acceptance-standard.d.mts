import type { DesignDimension, DesignMethodId } from './design-methods.js';

export type DesignAcceptanceIssue = {
  field: string;
  code: 'missing_acceptance_plan' | 'missing_method' | 'invalid_method' | 'required_method' | 'missing_reason'
    | 'missing_rule' | 'invalid_dimension' | 'missing_coverage' | 'invalid_risk' | 'coverage_conflict';
  message: string;
  ruleId?: string;
};

export const designAcceptancePolicy: {
  readonly version: 1;
  readonly gate: 'G-11';
  readonly methods: ReadonlyArray<{ id: DesignMethodId; label: string }>;
  readonly dimensions: ReadonlyArray<{ id: DesignDimension; label: string }>;
};

export function inspectDesignAcceptance(manifest: Record<string, unknown>): DesignAcceptanceIssue[];
