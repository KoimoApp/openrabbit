import { describe, expect, it, vi } from 'vitest';
import type { ReviewResponse } from '../src/types.js';

const { completeMock, createReviewMock } = vi.hoisted(() => ({
  completeMock: vi.fn(),
  createReviewMock: vi.fn(),
}));

vi.mock('../src/llm/index.js', () => ({
  createLLMClient: vi.fn(() => ({ complete: completeMock })),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: class {
    rest = {
      pulls: {
        get: vi.fn(async () => ({
          data: {
            title: 'Ship the real feature',
            body: 'Closes #42 and explains the user-facing behavior.',
            head: { sha: 'abc123', ref: 'feature/real-feature' },
            user: { login: 'contributor' },
          },
        })),
        listFiles: vi.fn(),
        createReview: createReviewMock,
      },
      issues: {
        get: vi.fn(async () => ({ data: { number: 42, title: 'Feature issue', body: 'Acceptance criteria', state: 'open' } })),
      },
      repos: {
        getContent: vi.fn(async () => ({ data: { content: Buffer.from('const x = 1\n').toString('base64') } })),
      },
    };

    paginate = {
      iterator: async function* () {
        yield { data: [{ filename: 'src/feature.ts', patch: '@@ -0,0 +1 @@\n+const x = 1\n' }] };
      },
    };
  },
}));

describe('runReview debiased single-pass flow', () => {
  it('synthesizes metadata while preserving comments and combining suggestions', async () => {
    const initialResponse: ReviewResponse = {
      summary: { verdict: 'question', overview: 'Diff-only summary', reuseNotes: [], actionItems: [] },
      comments: [{ path: 'src/feature.ts', line: 1, body: 'Keep this behavior covered.', type: 'question' }],
      separatePrSuggestions: ['Initial suggestion'],
    };
    const synthesisResponse: ReviewResponse = {
      summary: { verdict: 'needs changes', overview: 'Metadata-aware summary', reuseNotes: [], actionItems: [] },
      comments: [],
      separatePrSuggestions: ['Synthesis suggestion'],
    };
    completeMock.mockReset().mockResolvedValueOnce(initialResponse).mockResolvedValueOnce(synthesisResponse);
    createReviewMock.mockReset().mockResolvedValue({});

    const { runReview } = await import('../src/reviewer.js');
    await runReview({
      owner: 'owner',
      repo: 'repo',
      pullNumber: 7,
      githubToken: 'github-token',
      llmProvider: 'openrouter',
      llmApiUrl: 'https://api.example.com/v1',
      llmApiKey: 'llm-key',
      llmModel: 'model',
      llmReasoningEffort: 'medium',
      requestTimeoutMs: 120_000,
      reviewTimeoutMs: 120_000,
      reviewMode: 'both',
      toneMode: 'balanced',
      reviewLens: 'default',
      debiasedMode: true,
    });

    expect(completeMock).toHaveBeenCalledTimes(2);
    const initialPrompt = completeMock.mock.calls[0][0] as string;
    const synthesisPrompt = completeMock.mock.calls[1][0] as string;
    expect(initialPrompt).toContain('PR title and description are redacted for the initial pass');
    expect(initialPrompt).not.toContain('Ship the real feature');
    expect(initialPrompt).not.toContain('Closes #42 and explains the user-facing behavior.');
    expect(synthesisPrompt).toContain('Ship the real feature');
    expect(synthesisPrompt).toContain('Closes #42 and explains the user-facing behavior.');
    expect(synthesisPrompt).toContain('Final metadata-aware synthesis pass');

    const postedReview = createReviewMock.mock.calls[0][0] as { body: string; comments: Array<{ path: string }> };
    expect(postedReview.body).toContain('Metadata-aware summary');
    expect(postedReview.body).toContain('Initial suggestion');
    expect(postedReview.body).toContain('Synthesis suggestion');
    expect(postedReview.comments).toEqual([{ path: 'src/feature.ts', position: 1, body: '**question:** Keep this behavior covered.' }]);
  });
});
