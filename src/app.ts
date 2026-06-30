import 'dotenv/config';
import express from 'express';
import { App } from '@octokit/app';
import { createNodeMiddleware } from '@octokit/webhooks';
import { runReview } from './reviewer.js';
import type { ReviewLens, LLMProvider, ReviewMode, ToneMode } from './types.js';

const appId = process.env.APP_ID!;
const privateKey = process.env.PRIVATE_KEY!.replace(/\\n/g, '\n');
const webhookSecret = process.env.WEBHOOK_SECRET!;

const app = new App({
  appId,
  privateKey,
  webhooks: {
    secret: webhookSecret,
  },
});

app.webhooks.on('pull_request.opened', handlePullRequest);
app.webhooks.on('pull_request.reopened', handlePullRequest);
app.webhooks.on('pull_request.synchronize', handlePullRequest);
app.webhooks.on('pull_request.edited', handlePullRequest);

async function handlePullRequest({ octokit, payload }: any) {
  console.log(`Received pull_request event for ${payload.repository.full_name}#${payload.pull_request.number}`);

  const repository = payload.repository;
  const pullRequestNumber = payload.pull_request.number;

  const llmProvider = (process.env.LLM_PROVIDER || 'openrouter') as LLMProvider;
  const llmApiUrl = process.env.LLM_API_URL || 'https://openrouter.ai/api/v1';
  const llmApiKey = process.env.LLM_API_KEY || '';
  const llmModel = process.env.LLM_MODEL || 'openrouter/free';
  const reviewMode = (process.env.REVIEW_MODE || 'both') as ReviewMode;
  const toneMode = (process.env.TONE_MODE || 'balanced') as ToneMode;
  const reviewLens = (process.env.REVIEW_LENS || 'default') as ReviewLens;
  const debiasedMode = process.env.DEBIASED_MODE === 'true';

  if (!llmApiKey) {
    console.error('LLM_API_KEY is not set');
    return;
  }

  // Get installation token
  const installationId = payload.installation.id;
  const { token } = await app.getInstallationOctokit(installationId).then(it => it.auth() as Promise<{ token: string }>);

  try {
    await runReview({
      owner: repository.owner.login,
      repo: repository.name,
      pullNumber: pullRequestNumber,
      githubToken: token,
      llmProvider,
      llmApiUrl,
      llmApiKey,
      llmModel,
      reviewMode,
      toneMode,
      reviewLens,
      debiasedMode,
    });
    console.log(`Successfully reviewed ${payload.repository.full_name}#${payload.pull_request.number}`);
  } catch (error) {
    console.error(`Error reviewing ${payload.repository.full_name}#${payload.pull_request.number}:`, error);
  }
}

const expressApp = express();
const port = process.env.PORT || 3000;

expressApp.use(createNodeMiddleware(app.webhooks));

expressApp.listen(port, () => {
  console.log(`OpenRabbit GitHub App listening at http://localhost:${port}`);
});
