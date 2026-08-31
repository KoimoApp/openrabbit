import { GroqClient } from './groq.js';
import type { LLMCompletionOptions, LLMConfig, LLMProvider, ReviewResponse } from '../types.js';

export interface LLMClient {
  complete(prompt: string, options?: LLMCompletionOptions): Promise<ReviewResponse>;
}

export function createLLMClient(provider: LLMProvider, config: LLMConfig): LLMClient {
  if (provider === 'groq' || provider === 'openrouter') {
    return new GroqClient(config);
  }
  throw new Error(`Unsupported provider ${provider}`);
}
