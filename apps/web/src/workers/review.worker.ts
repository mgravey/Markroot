/// <reference lib="webworker" />
import { createReviewDraft } from '@markroot/review';
import type { ReviewWorkerRequest, ReviewWorkerResponse } from './review.protocol.js';

self.addEventListener('message', (event: MessageEvent<ReviewWorkerRequest>) => {
  const message = event.data;
  try {
    respond({ type: 'result', id: message.id, draft: createReviewDraft(message.base, message.compare, message.baseFingerprint) });
  } catch (error) {
    respond({
      type: 'error',
      id: message.id,
      error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) },
    });
  }
});

function respond(message: ReviewWorkerResponse): void { self.postMessage(message); }
