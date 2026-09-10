import { fetch } from 'undici';
import type { LLMClient } from './index.js';
import type { LLMCompletionOptions, LLMConfig, ReviewCommentType, ReviewResponse } from '../types.js';

const VALID_COMMENT_TYPES: ReviewCommentType[] = ['bug', 'scope-drift', 'reuse', 'security', 'question', 'suggestion', 'style'];
const VALID_VERDICTS = new Set(['ready to merge', 'looks good to me', 'needs changes', 'question', 'scope-drift']);
const MAX_REPAIR_CANDIDATE_CHARS = 12_000;

function extractTextFromResponse(body: any): string {
  if (!body) {
    return '';
  }
  if (typeof body === 'string') {
    return body;
  }
  const choice = Array.isArray(body.choices) ? body.choices[0] : null;
  if (choice) {
    if (typeof choice.text === 'string') {
      return choice.text;
    }
    if (choice.message && typeof choice.message.content === 'string') {
      return choice.message.content;
    }
    if (typeof choice.delta?.content === 'string') {
      return choice.delta.content;
    }
  }
  if (typeof body.output === 'string') {
    return body.output;
  }
  if (Array.isArray(body.outputs) && typeof body.outputs[0]?.content === 'string') {
    return body.outputs[0].content;
  }
  return JSON.stringify(body);
}

function normalizeReviewResponse(value: unknown): ReviewResponse {
  if (!value || typeof value !== 'object') {
    return {
      summary: {
        overview: '',
        reuseNotes: [],
        actionItems: [],
      },
      comments: [],
      separatePrSuggestions: [],
    };
  }

  const parsed = value as Record<string, unknown>;
  const summarySource = parsed.summary ?? parsed.review ?? '';
  const summary = typeof summarySource === 'string'
    ? {
        overview: summarySource.trim(),
        reuseNotes: [],
        actionItems: [],
      }
    : {
        verdict: typeof (summarySource as Record<string, unknown>)?.verdict === 'string'
          ? ((summarySource as Record<string, unknown>).verdict as string).trim()
          : undefined,
        primaryGoal: typeof (summarySource as Record<string, unknown>)?.primaryGoal === 'string'
          ? ((summarySource as Record<string, unknown>).primaryGoal as string).trim()
          : undefined,
        overview: typeof (summarySource as Record<string, unknown>)?.overview === 'string'
          ? ((summarySource as Record<string, unknown>).overview as string).trim()
          : undefined,
        scopeAssessment: typeof (summarySource as Record<string, unknown>)?.scopeAssessment === 'string'
          ? ((summarySource as Record<string, unknown>).scopeAssessment as string).trim()
          : undefined,
        riskAssessment: typeof (summarySource as Record<string, unknown>)?.riskAssessment === 'string'
          ? ((summarySource as Record<string, unknown>).riskAssessment as string).trim()
          : undefined,
        reuseNotes: Array.isArray((summarySource as Record<string, unknown>)?.reuseNotes)
          ? ((summarySource as Record<string, unknown>).reuseNotes as unknown[]).filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
          : [],
        actionItems: Array.isArray((summarySource as Record<string, unknown>)?.actionItems)
          ? ((summarySource as Record<string, unknown>).actionItems as unknown[]).filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
          : [],
      };

  const comments = Array.isArray(parsed.comments)
    ? parsed.comments
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        path: typeof item.path === 'string' ? item.path : '',
        line: typeof item.line === 'number' && item.line > 0 ? item.line : 1,
        body: typeof item.body === 'string' ? item.body.trim() : '',
        type: typeof item.type === 'string' && VALID_COMMENT_TYPES.includes(item.type as ReviewCommentType)
          ? item.type as ReviewCommentType
          : undefined,
        suggestion: typeof item.suggestion === 'string' ? item.suggestion.trim() : undefined,
      }))
      .filter((item) => item.path && item.body)
    : [];

  const separatePrSuggestions = Array.isArray(parsed.separate_pr_suggestions)
    ? parsed.separate_pr_suggestions.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];

  return { summary, comments, separatePrSuggestions };
}

function parseReviewResponse(raw: string): ReviewResponse {
  const text = raw.trim();

  function requireVerdict(value: unknown): ReviewResponse {
    const review = normalizeReviewResponse(value);
    const verdict = review.summary.verdict?.toLowerCase();
    if (!verdict || !VALID_VERDICTS.has(verdict)) {
      throw new Error('LLM response was not valid JSON.');
    }
    review.summary.verdict = verdict;
    return review;
  }

  try {
    return requireVerdict(JSON.parse(text));
  } catch {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return requireVerdict(JSON.parse(text.slice(first, last + 1)));
      } catch {
      }
    }
    throw new Error('LLM response was not valid JSON.');
  }
}

function buildRepairPrompt(candidate: string): string {
  return `Repair this malformed review candidate into one valid JSON object. Preserve its verdict and findings; do not add a new judgment or prose outside the JSON.

Required shape:
{"summary":{"verdict":"ready to merge|looks good to me|needs changes|question|scope-drift","primaryGoal":"","overview":"","scopeAssessment":"","riskAssessment":"","reuseNotes":[],"actionItems":[]},"comments":[],"separate_pr_suggestions":[]}

Candidate:
${candidate.slice(0, MAX_REPAIR_CANDIDATE_CHARS)}`;
}

function hasReviewVerdict(candidate: string): boolean {
  const normalized = candidate.toLowerCase();
  const marker = normalized.indexOf('verdict');
  if (marker < 0) return false;
  const verdictField = normalized.slice(marker, marker + 200);
  return [...VALID_VERDICTS].some((verdict) => verdictField.includes(verdict));
}

function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const details: string[] = [error.message];
  const errorWithCause = error as Error & { cause?: unknown; code?: string };
  if (errorWithCause.code) {
    details.push(`code=${errorWithCause.code}`);
  }

  if (errorWithCause.cause && typeof errorWithCause.cause === 'object') {
    const cause = errorWithCause.cause as { message?: string; code?: string };
    if (cause.message) {
      details.push(`cause=${cause.message}`);
    }
    if (cause.code) {
      details.push(`causeCode=${cause.code}`);
    }
  }

  return details.join(', ');
}

export class GroqClient implements LLMClient {
  private static readonly defaultRequestTimeoutMs = 120_000;
  readonly apiKey: string;
  readonly apiUrl: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly requestTimeoutMs: number;

  constructor(config: LLMConfig) {
    this.apiKey = config.apiKey;
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.model = config.model;
    this.reasoningEffort = config.reasoningEffort;
    this.requestTimeoutMs = config.requestTimeoutMs ?? GroqClient.defaultRequestTimeoutMs;
  }

  private buildEndpoints(): string[] {
    const base = this.apiUrl;
    if (base.endsWith('/v1')) {
      return [`${base}/chat/completions`];
    }
    return [`${base}/v1/chat/completions`, `${base}/chat/completions`];
  }

  private buildRequestBody(prompt: string) {
    return {
      model: this.model,
      messages: [
        {
          role: 'system',
          content: 'You are an expert code reviewer. Return only valid JSON matching the requested review schema, keep the complete response under 1200 tokens, and do not include prose outside the JSON object. Always include summary.verdict; omit optional detail before omitting required fields.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 1,
      max_tokens: 1536,
      top_p: 1,
      reasoning_effort: this.reasoningEffort,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      stream: false,
    };
  }

  async complete(prompt: string, options: LLMCompletionOptions = {}): Promise<ReviewResponse> {
    const endpoints = this.buildEndpoints();
    const failures: string[] = [];
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('LLM completion timeout must be greater than zero.');
    }
    const deadline = Date.now() + Math.min(this.requestTimeoutMs, timeoutMs);

    for (const url of endpoints) {
      let canRetryMalformedJson = true;
      let requestPrompt = prompt;
      while (true) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          break;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), remainingMs);
        let responseText = '';
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(this.buildRequestBody(requestPrompt)),
            signal: controller.signal,
          });

          if (!response.ok) {
            const responseText = await response.text();
            throw new Error(`LLM API error ${response.status} from ${url}: ${responseText}`);
          }

          const responseBody = await response.json();
          responseText = extractTextFromResponse(responseBody);
          return parseReviewResponse(responseText);
        } catch (error) {
          failures.push(`request to ${url} failed: ${describeFetchError(error)}`);
          if (canRetryMalformedJson && error instanceof Error && error.message === 'LLM response was not valid JSON.') {
            canRetryMalformedJson = false;
            requestPrompt = hasReviewVerdict(responseText) ? buildRepairPrompt(responseText) : prompt;
            continue;
          }
          break;
        } finally {
          clearTimeout(timeout);
        }
      }
    }

    throw new Error(`LLM request failed for all endpoints. Errors: ${failures.join(' | ') || 'unknown error'}`);
  }
}
