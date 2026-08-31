export type ReviewMode = 'summary' | 'inline' | 'both';
export type LLMProvider = 'groq' | 'openrouter';
export type ToneMode = 'balanced' | 'direct' | 'supportive';
export type ReviewLens = 'default' | 'security' | 'socratic' | 'performance' | 'scope-guard';
export interface LLMConfig {
  apiKey: string;
  apiUrl: string;
  model: string;
  reasoningEffort: string;
  /** Maximum time allowed for each provider request, in milliseconds. */
  requestTimeoutMs?: number;
}
export interface LLMCompletionOptions {
  /** Maximum time allowed for this completion, in milliseconds. */
  timeoutMs?: number;
}
export type ReviewCommentType = 'bug' | 'scope-drift' | 'reuse' | 'security' | 'question' | 'suggestion' | 'style';
export interface ReviewSummary {
  verdict?: string;
  primaryGoal?: string;
  overview?: string;
  scopeAssessment?: string;
  riskAssessment?: string;
  reuseNotes: string[];
  actionItems: string[];
}
export interface ReviewComment {
  path: string;
  line: number;
  body: string;
  type?: ReviewCommentType;
  suggestion?: string;
}
export interface ReviewResponse {
  summary: ReviewSummary;
  comments: ReviewComment[];
  separatePrSuggestions: string[];
  requestedFiles?: string[];
}
export interface ReviewContext {
  owner: string;
  repo: string;
  pullNumber: number;
  githubToken: string;
  llmProvider: LLMProvider;
  llmApiUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmReasoningEffort: string;
  requestTimeoutMs?: number;
  /** Maximum time allowed for the complete review, in milliseconds (defaults to 240000). */
  reviewTimeoutMs?: number;
  reviewMode: ReviewMode;
  toneMode: ToneMode;
  reviewLens: ReviewLens;
  debiasedMode: boolean;
}
