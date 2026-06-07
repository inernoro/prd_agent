import { apiRequest } from './apiClient';
import type {
  CreateSpeechDeckInput,
  SpeechAgentApi,
  UpdateSpeechDeckInput,
  UpdateSpeechNodeInput,
} from '@/services/contracts/speechAgent';

export const speechAgentApi: SpeechAgentApi = {
  listDecks: (page = 1, pageSize = 20) =>
    apiRequest(`/api/speech-agent/decks?page=${page}&pageSize=${pageSize}`),

  getDeck: (deckId) =>
    apiRequest(`/api/speech-agent/decks/${encodeURIComponent(deckId)}`),

  createDeck: (input: CreateSpeechDeckInput) =>
    apiRequest('/api/speech-agent/decks', { method: 'POST', body: input }),

  createFromDocument: (input) =>
    apiRequest('/api/speech-agent/decks/from-document', { method: 'POST', body: input }),

  updateDeck: (deckId, input: UpdateSpeechDeckInput) =>
    apiRequest(`/api/speech-agent/decks/${encodeURIComponent(deckId)}`, { method: 'PATCH', body: input }),

  deleteDeck: (deckId) =>
    apiRequest(`/api/speech-agent/decks/${encodeURIComponent(deckId)}`, { method: 'DELETE' }),

  updateNode: (deckId, nodeId, input: UpdateSpeechNodeInput) =>
    apiRequest(`/api/speech-agent/decks/${encodeURIComponent(deckId)}/nodes/${encodeURIComponent(nodeId)}`, {
      method: 'PATCH',
      body: input,
    }),

  generateNodeImage: (deckId, nodeId) =>
    apiRequest(`/api/speech-agent/decks/${encodeURIComponent(deckId)}/nodes/${encodeURIComponent(nodeId)}/generate-image`, {
      method: 'POST',
      body: {},
    }),

  generateNodeNotes: (deckId, nodeId) =>
    apiRequest(`/api/speech-agent/decks/${encodeURIComponent(deckId)}/nodes/${encodeURIComponent(nodeId)}/generate-notes`, {
      method: 'POST',
      body: {},
    }),

  generateNotesBatch: (deckId) =>
    apiRequest(`/api/speech-agent/decks/${encodeURIComponent(deckId)}/generate-notes-batch`, {
      method: 'POST',
      body: {},
    }),

  rewriteNode: (deckId, nodeId, style) =>
    apiRequest(`/api/speech-agent/decks/${encodeURIComponent(deckId)}/nodes/${encodeURIComponent(nodeId)}/rewrite`, {
      method: 'POST',
      body: { style },
    }),

  publishDeck: (deckId) =>
    apiRequest(`/api/speech-agent/decks/${encodeURIComponent(deckId)}/publish`, {
      method: 'POST',
      body: {},
    }),
};
