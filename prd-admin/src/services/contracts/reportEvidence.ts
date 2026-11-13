/** Server-owned facts. Clients display these labels and never infer stages from commit counts. */
export interface ReportEvidenceCitation {
  id: string;
  uri: string;
  excerpt: string;
  occurredAt: string;
  kind: string;
  revision?: string;
}

export interface ReportDeliveryItem {
  id: string;
  title: string;
  owner?: string;
  movement: string;
  previousSummary: string;
  codeStatus: string;
  codeLabel: string;
  validationStatus: string;
  validationLabel: string;
  releaseStatus: string;
  releaseLabel: string;
  revision?: string;
  blockReason?: string;
  nextStep?: string;
  sources: ReportEvidenceCitation[];
}

export interface ReportEvidenceMetric {
  key: string;
  label: string;
  available: boolean;
  text: string;
  sources: ReportEvidenceCitation[];
}

export interface ReportDeliverySnapshot {
  schemaVersion: number;
  periodStart: string;
  periodEnd: string;
  timeZone: string;
  headline: string;
  items: ReportDeliveryItem[];
  limitations: string[];
  metrics: ReportEvidenceMetric[];
}
