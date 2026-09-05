import type { ReviewDraft } from '@markroot/review';
import type { ReviewWorkerRequest, ReviewWorkerResponse } from './review.protocol.js';

export function createReviewDraftInWorker(base: string, compare: string, baseFingerprint: string): Promise<ReviewDraft> {
  const worker = new Worker(new URL('./review.worker.ts', import.meta.url), { type: 'module', name: 'markroot-review-diff' });
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const finish = () => worker.terminate();
    worker.addEventListener('message', (event: MessageEvent<ReviewWorkerResponse>) => {
      if (event.data.id !== id) return;
      finish();
      if (event.data.type === 'result') resolve(event.data.draft);
      else reject(Object.assign(new Error(event.data.error.message), { name: event.data.error.name }));
    });
    worker.addEventListener('error', (event) => { finish(); reject(new Error(event.message || 'The review worker stopped unexpectedly.')); });
    worker.postMessage({ id, base, compare, baseFingerprint } satisfies ReviewWorkerRequest);
  });
}
