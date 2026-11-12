import type { DocumentStore } from './documentStore';

export interface WritingTemplate { id: string; name: string; type: string; role: string; useWhen: string; version: string; headings: { title: string; hint: string }[] }
export interface WritingSource { id: string; entryId: string; title: string; content: string; hash: string; updatedAt: string; status: string }
export interface WritingParagraph { id: string; text: string; status: 'src' | 'auth' | 'ask' | 'conf'; citations: string[]; quotes?: Record<string, string>; confirmed: boolean }
export interface WritingSection { id: string; title: string; paragraphs: WritingParagraph[]; condition?: string; detail?: { label: string; rows: string[][] }; metadataConfirmed?: boolean }
export interface WritingQuestion { id: string; kind: string; paragraphId: string; sectionTitle: string; title: string; why: string; citations: string[]; options: string[]; choices?: { key: string; label: string; text: string }[]; evidence?: { sourceId: string; quote: string; location: string }[]; status: string; answer: string }
export interface WritingRole { label: string; action: string; condition: string; sectionId: string; orderedSectionIds?: string[] }
export interface WritingCaption { id: string; text: string; at: number }
export interface WritingChapter { id: string; title: string; start: number; steps: { id: string; text: string; condition: string; at: number }[] }
export interface WritingPublication {
  version: number; title: string; summary: string; templateId: string; templateVersion: string;
  authorName: string; reviewerName: string; publishedAt: string; conclusions: string[]; scopeIn: string; scopeOut: string;
  sections: WritingSection[]; sources: WritingSource[]; roles: WritingRole[]; openQuestions: WritingQuestion[]; chapters: WritingChapter[]; captions?: WritingCaption[]; videoEntryId?: string;
}
export interface WritingState {
  revision: number; stage: string; templateId: string; templateVersion: string; title: string; summary: string; manualInput: string;
  authorId: string; authorName: string; reviewerId: string; reviewerName: string; scopeIn: string; scopeOut: string;
  conclusions: string[]; intentPoints: string[]; sources: WritingSource[]; sections: WritingSection[]; questions: WritingQuestion[];
  roles: WritingRole[]; chapters: WritingChapter[]; captions?: WritingCaption[]; videoEntryId?: string; activeRunId?: string; failure?: string; updatedAt: string; published?: WritingPublication;
}
export interface WritingContext {
  store: DocumentStore; teamNames?: string[]; projectName?: string; actorId: string; actorName: string; reviewerId: string; reviewerName: string; templates: WritingTemplate[];
  sources: { id: string; title: string; summary?: string; contentType: string; updatedAt: string; createdBy: string; authorName?: string; fileSize: number; sortOrder?: number; metadata: Record<string, string>; published: boolean }[];
}
export interface WritingDocument { entryId: string; store: DocumentStore; state: WritingState; canApprove: boolean; run?: { id: string; status: string; phase: string; progress: number; createdAt: string; startedAt?: string; generatedText?: string; errorMessage?: string } }
export interface WritingReader { entryId: string; store: DocumentStore; publication: WritingPublication; template?: WritingTemplate; affectedSources: string[]; entries: { id: string; title: string }[]; canEdit: boolean }
