import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('published action contract', () => {
  it('runs the committed bundle without nested actions or runtime package commands', () => {
    const action = readFileSync(resolve(root, 'action.yml'), 'utf8');

    expect(action).toMatch(/using:\s*node24/);
    expect(action).toMatch(/main:\s*dist\/index\.js/);
    expect(action).not.toMatch(/^\s+uses:/m);
    expect(action).not.toMatch(/npm\s+(install|ci|run\s+build)/);
  });

  it('ships the action entrypoint referenced by action.yml', () => {
    expect(existsSync(resolve(root, 'dist/index.js'))).toBe(true);
  });

  it('pins every remote action used by repository workflows', () => {
    const workflowRoot = resolve(root, '.github/workflows');
    const workflows = readdirSync(workflowRoot)
      .filter((name) => name.endsWith('.yml'))
      .map((name) => readFileSync(resolve(workflowRoot, name), 'utf8'))
      .join('\n');
    const uses = [...workflows.matchAll(/^\s*uses:\s*(\S+)/gmu)].map((match) => match[1]);

    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      expect(action.startsWith('./') || /@[0-9a-f]{40}$/u.test(action)).toBe(true);
    }
  });

  it('validates pull request code without write permissions or lifecycle scripts', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/pr-review.yml'), 'utf8');

    expect(workflow).toMatch(/^\s*pull_request:\s*$/mu);
    expect(workflow).not.toContain('pull_request_target:');
    expect(workflow).not.toMatch(/pull-requests:\s*write/u);
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('npm ci --ignore-scripts');
  });
});
