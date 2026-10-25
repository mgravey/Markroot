/// <reference lib="webworker" />
import { createReviewDraft } from '@markroot/review';
import { attributeChanges } from '../review-attribution.js';
import type { ReviewWorkerRequest, ReviewWorkerResponse } from './review.protocol.js';

/** Word diffs that take longer than this are reported as too large to review inline. */
const REVIEW_DIFF_TIMEOUT_MS = 10_000;

self.addEventListener('message', (event: MessageEvent<ReviewWorkerRequest>) => {
  const message = event.data;
  try {
    if (message.type === 'attribute') respond({ type: 'attribution', id: message.id, attribution: [...attributeChanges(message.input, message.versions)] });
    else respond({ type: 'result', id: message.id, draft: createReviewDraft(message.base, message.compare, message.baseFingerprint, new Map(), { timeout: REVIEW_DIFF_TIMEOUT_MS }) });
  } catch (error) {
    respond({
      type: 'error',
      id: message.id,
      error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) },
    });
  }
});

function respond(message: ReviewWorkerResponse): void { self.postMessage(message); }
