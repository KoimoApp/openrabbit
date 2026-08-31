import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GroqClient } from '../src/llm/groq.js';

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock('undici', () => ({
  fetch: fetchMock,
}));

describe('GroqClient', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('tries the chat completion endpoint first when the base URL already ends with /v1', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '{"review":"Looks good","comments":[]}',
              },
            },
          ],
        }),
      });

    const client = new GroqClient({
      apiKey: 'test-key',
      apiUrl: 'https://api.groq.com/openai/v1',
      model: 'openai/gpt-oss-120b',
      reasoningEffort: 'low',
    });

    const response = await client.complete('Review this');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.groq.com/openai/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"reasoning_effort":"low"'),
      }),
    );
    expect(response.summary.overview).toBe('Looks good');
    expect(response.comments).toEqual([]);
  });

  it('prepends /v1 when the configured base URL omits it', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"review":"Looks good","comments":[]}',
            },
          },
        ],
      }),
    });

    const client = new GroqClient({
      apiKey: 'test-key',
      apiUrl: 'https://api.groq.com/openai',
      model: 'openai/gpt-oss-120b',
      reasoningEffort: 'medium',
    });

    await client.complete('Review this');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.groq.com/openai/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reports every attempted endpoint when requests fail', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => '{"error":"missing"}',
      });

    const client = new GroqClient({
      apiKey: 'test-key',
      apiUrl: 'https://api.groq.com/openai',
      model: 'openai/gpt-oss-120b',
      reasoningEffort: 'medium',
    });

    await expect(client.complete('Review this')).rejects.toThrow(
      'LLM request failed for all endpoints. Errors: request to https://api.groq.com/openai/v1/chat/completions failed: fetch failed | request to https://api.groq.com/openai/chat/completions failed: LLM API error 404 from https://api.groq.com/openai/chat/completions: {"error":"missing"}',
    );
  });

  it('aborts a provider request after the configured timeout', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('request aborted')));
    }));

    const client = new GroqClient({
      apiKey: 'test-key',
      apiUrl: 'https://api.example.com/v1',
      model: 'example-model',
      requestTimeoutMs: 25,
    });

    const started = Date.now();
    await expect(client.complete('Review this')).rejects.toThrow('request aborted');
    expect(Date.now() - started).toBeLessThan(500);
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('clamps a completion to the remaining review deadline', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('review deadline reached')));
      }));

      const client = new GroqClient({
        apiKey: 'test-key',
        apiUrl: 'https://api.example.com/v1',
        model: 'example-model',
        reasoningEffort: 'medium',
        requestTimeoutMs: 500,
      });

      const completion = client.complete('Review this', { timeoutMs: 40 });
      const rejection = expect(completion).rejects.toThrow('review deadline reached');
      await vi.advanceTimersByTimeAsync(39);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a retry only the remaining time from the total timeout', async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockImplementationOnce(() => new Promise((_, reject) => {
          setTimeout(() => reject(new Error('first endpoint failed')), 30);
        }))
        .mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('retry aborted')));
        }));

      const client = new GroqClient({
        apiKey: 'test-key',
        apiUrl: 'https://api.example.com',
        model: 'example-model',
        requestTimeoutMs: 50,
      });

      const completion = client.complete('Review this');
      const rejection = expect(completion).rejects.toThrow('retry aborted');
      await vi.advanceTimersByTimeAsync(30);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(19);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start another endpoint after the total timeout expires', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('request aborted')));
      }));

      const client = new GroqClient({
        apiKey: 'test-key',
        apiUrl: 'https://api.example.com',
        model: 'example-model',
        requestTimeoutMs: 50,
      });

      const completion = client.complete('Review this');
      const rejection = expect(completion).rejects.toThrow('LLM request failed for all endpoints');
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
