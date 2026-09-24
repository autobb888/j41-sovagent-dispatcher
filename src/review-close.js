'use strict';

const { parseRating, reviewableJobStatus } = require('./buyer-review');

function decideReviewAsk({ json, yes, rating, tty } = {}) {
  const hasRating = rating != null && String(rating).trim() !== '';
  if (hasRating) {
    const parsed = parseRating(rating);
    if (parsed == null) return { action: 'bad-rating' };
    return { action: 'submit', rating: parsed };
  }
  if (json || yes || !tty) return { action: 'leave' };
  return { action: 'ask' };
}

function parseReviewReply(line) {
  const text = String(line == null ? '' : line).trim();
  if (!text || /^(s|skip|n|no)$/i.test(text)) return { skipped: true };
  const match = text.match(/^([1-5])(?:\s+([\s\S]+))?$/);
  if (!match) return { invalid: true };
  return { rating: Number(match[1]), message: (match[2] || '').trim() };
}

async function askReviewOnClose({ ask } = {}) {
  if (typeof ask !== 'function') return { skipped: true };
  const ratingLine = await ask('Rating 1-5, or press Enter to skip: ');
  const parsed = parseReviewReply(ratingLine);
  if (parsed.skipped) return { skipped: true };
  if (parsed.invalid) return { invalid: true };
  if (parsed.message) return { rating: parsed.rating, message: parsed.message };
  const sentence = await ask('Review sentence, or press Enter to leave it blank: ');
  return { rating: parsed.rating, message: String(sentence || '').trim() };
}

function chainReviewCountOf(agent) {
  const row = agent && agent.data && agent.chainReviewCount == null ? agent.data : agent;
  const count = Number(row && row.chainReviewCount);
  return Number.isFinite(count) ? count : 0;
}

function publishedReview(row, expect) {
  const body = row && row.data && row.jobHash == null && row.verified == null && !Array.isArray(row.data)
    ? row.data
    : row;
  if (!body || typeof body !== 'object') return null;
  if (Array.isArray(body)) {
    for (const item of body) {
      const found = publishedReview(item, expect);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(body.data)) return publishedReview(body.data, expect);
  if (body.verified !== true) return null;
  if (expect && expect.jobHash && body.jobHash === expect.jobHash) return body;
  if (expect && expect.sessionId && body.sessionId === expect.sessionId) return body;
  return null;
}

async function readReviewBaseline(client, seller) {
  if (!client || typeof client.getAgent !== 'function' || !seller) return 0;
  try {
    return chainReviewCountOf(await client.getAgent(seller));
  } catch {
    return 0;
  }
}

async function waitForWrittenReview({
  baselineCount = 0,
  readCount,
  readPublished,
  expect,
  timeoutMs = 1800000,
  intervalMs = 5000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  onProgress,
} = {}) {
  const start = now();
  let count = Number(baselineCount) || 0;
  let publicReview = null;
  for (;;) {
    if (typeof readPublished === 'function') {
      try {
        const found = publishedReview(await readPublished(), expect);
        if (found) publicReview = found;
      } catch { /* the review list is not ready yet */ }
    }
    if (typeof readCount === 'function') {
      try {
        count = chainReviewCountOf(await readCount());
      } catch { /* keep the last count */ }
    }
    if (count > baselineCount) {
      return {
        ok: true,
        code: 'REVIEW_WRITTEN',
        count,
        baseline: baselineCount,
        publicReview,
      };
    }
    // The review list is the public record. chainReviewCount catches up later.
    if (publicReview) {
      return {
        ok: true,
        code: 'REVIEW_PUBLIC',
        count,
        baseline: baselineCount,
        publicReview,
      };
    }
    if (now() - start >= timeoutMs) {
      return {
        ok: false,
        code: 'REVIEW_NOT_PUBLIC',
        count,
        baseline: baselineCount,
        publicReview,
      };
    }
    await sleep(intervalMs);
  }
}

function reviewWriteMessage(result) {
  if (!result) return 'Review was not checked.';
  if (result.skipped) return 'Review skipped.';
  if (result.ok && result.code === 'REVIEW_WRITTEN') {
    return `Review written. chainReviewCount ${result.baseline} → ${result.count}.`;
  }
  if (result.code === 'REVIEW_PUBLIC' || result.code === 'REVIEW_COUNT_LAGGING') {
    const id = result.publicReview && result.publicReview.id;
    const shown = id ? `Review ${id} is public` : 'The review is public';
    return `${shown}. chainReviewCount is still ${result.count}.`;
  }
  if (result.message) return result.message;
  return 'Review was submitted and is not on the public review list yet.';
}

function envMs(name, fallback) {
  if (process.env[name] == null || process.env[name] === '') return fallback;
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const REVIEW_COUNT_TIMEOUT_MS = envMs('J41_REVIEW_COUNT_TIMEOUT_MS', 1800000);
const REVIEW_COUNT_INTERVAL_MS = envMs('J41_REVIEW_COUNT_INTERVAL_MS', 5000);

async function finishReviewWrite({
  client,
  seller,
  jobHash,
  sessionId,
  baselineCount,
  timeoutMs = REVIEW_COUNT_TIMEOUT_MS,
  intervalMs = REVIEW_COUNT_INTERVAL_MS,
  sleep,
  now,
  onProgress,
} = {}) {
  return waitForWrittenReview({
    baselineCount,
    timeoutMs,
    intervalMs,
    sleep,
    now,
    onProgress,
    expect: sessionId ? { sessionId } : { jobHash },
    readCount: async () => client.getAgent(seller),
    readPublished: async () => (
      sessionId
        ? client.getAgentReviews(seller, { limit: 20 })
        : client.getJobReview(jobHash)
    ),
  });
}

module.exports = {
  reviewableJobStatus,
  decideReviewAsk,
  parseReviewReply,
  askReviewOnClose,
  chainReviewCountOf,
  publishedReview,
  readReviewBaseline,
  waitForWrittenReview,
  reviewWriteMessage,
  finishReviewWrite,
  REVIEW_COUNT_TIMEOUT_MS,
  REVIEW_COUNT_INTERVAL_MS,
};
