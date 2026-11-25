export interface QuickVideoTemplate {
  id: string;
  name: string;
  description: string;
}

export interface QuickVideoInput {
  templateId: string;
  templateRequestId: string;
  articleTitle?: string;
  articleMarkdown: string;
}

export interface QuickVideoSummary {
  id: string;
  templateId: string;
  articleTitle: string;
  currentPhase: string;
  status: 'Queued' | 'Running' | 'Completed' | 'Failed';
  createdAt: string;
  publishedSiteId?: string;
}

export interface QuickVideoRun extends QuickVideoSummary {
  articleMarkdown: string;
  phaseProgress: number;
  videoAssetUrl?: string;
  totalDurationSeconds: number;
  errorCode?: string;
  errorMessage?: string;
}
