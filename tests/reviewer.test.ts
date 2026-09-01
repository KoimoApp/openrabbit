import { describe, expect, it } from 'vitest';
import { buildReviewPrompt, filterRepositoryTreePaths, parseReviewResponse, shouldSkipFile } from '../src/reviewer.js';

describe('reviewer prompt', () => {
  it('generates a prompt with title and patch snippets', () => {
    const prompt = buildReviewPrompt({
      title: 'Feature update',
      body: 'Adds new validation',
      reviewMode: 'both',
      toneMode: 'balanced',
      changedFiles: [
        { path: 'src/index.ts', patch: '+const x = 1\n' },
      ],
      repositoryFiles: ['src/index.ts'],
    });
    expect(prompt).toContain('Feature update');
    expect(prompt).toContain('src/index.ts');
    expect(prompt).toContain('REVIEW MODE: both');
  });
});

describe('review response parser', () => {
  it('parses a valid JSON review response', () => {
    const response = parseReviewResponse('{"summary":{"verdict":"question","overview":"Looks good","reuseNotes":[],"actionItems":[]},"comments":[{"path":"src/index.ts","line":5,"type":"question","body":"Fix this."}],"separate_pr_suggestions":["Split config changes"]}');
    expect(response.summary.overview).toBe('Looks good');
    expect(response.comments).toHaveLength(1);
    expect(response.comments[0].path).toBe('src/index.ts');
    expect(response.comments[0].type).toBe('question');
    expect(response.separatePrSuggestions).toEqual(['Split config changes']);
  });

  it('falls back gracefully for plain text responses', () => {
    const response = parseReviewResponse('Some review without JSON');
    expect(response.summary.overview).toBe('Some review without JSON');
    expect(response.comments).toEqual([]);
  });
});

describe('generated files', () => {
  it('skips Drizzle snapshots but keeps migrations reviewable', () => {
    expect(shouldSkipFile('packages/database/drizzle/core/meta/0046_snapshot.json')).toBe(true);
    expect(shouldSkipFile('packages/database/drizzle/core/0046_youthful_supernaut.sql')).toBe(false);
  });
});

describe('repository tree inventory', () => {
  it('keeps reviewable blobs and drops trees, binaries, and dependency or build directories', () => {
    const paths = filterRepositoryTreePaths([
      { path: 'src', type: 'tree' },
      { path: 'src/index.ts', type: 'blob' },
      { path: 'package.json', type: 'blob' },
      { path: 'node_modules/leftpad/index.js', type: 'blob' },
      { path: 'packages/app/dist/bundle.js', type: 'blob' },
      { path: 'assets/logo.png', type: 'blob' },
      { path: '.github/workflows/ci.yml', type: 'blob' },
    ]);
    expect(paths).toEqual(['.github/workflows/ci.yml', 'package.json', 'src/index.ts']);
  });

  it('caps and sorts the inventory deterministically', () => {
    const entries = Array.from({ length: 260 }, (_, index) => ({
      path: `src/file${String(index).padStart(4, '0')}.ts`,
      type: 'blob',
    }));
    const paths = filterRepositoryTreePaths(entries);
    expect(paths).toHaveLength(200);
    expect(paths[0]).toBe('src/file0000.ts');
    expect(paths[199]).toBe('src/file0199.ts');
  });
});
