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

  updateDeck: (deckId, input: UpdateSpeechDeckInput) =>
    apiRequest(`/api/speech-agent/decks/${encodeURIComponent(deckId)}`, { method: 'PATCH', body: input }),

  deleteDeck: (deckId) =>
    apiRequest(`/api/speech-agent/decks/${encodeURIComponent(deckId)}`, { method: 'DELETE' }),

  updateNode: (deckId, nodeId, input: UpdateSpeechNodeInput) =>
    apiRequest(`/api/speech-agent/decks/${encodeURIComponent(deckId)}/nodes/${encodeURIComponent(nodeId)}`, {
      method: 'PATCH',
      body: input,
    }),
};
