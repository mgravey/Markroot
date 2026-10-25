import type { AuthorIdentity } from '@markroot/core';
import type { ReviewDraft } from '@markroot/review';
import type { AttributionInput, AttributionVersion } from '../review-attribution.js';
import type { ReviewWorkerRequest, ReviewWorkerResponse } from './review.protocol.js';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export interface ReviewWorkerOptions {
  readonly signal?: AbortSignal;
  /** Test seam; defaults to a fresh module worker per call. */
  readonly createWorker?: () => Worker;
}

export async function createReviewDraftInWorker(base: string, compare: string, baseFingerprint: string, options: ReviewWorkerOptions = {}): Promise<ReviewDraft> {
  const response = await runReviewWorker({ type: 'draft', base, compare, baseFingerprint }, options);
  if (response.type !== 'result') throw new Error('The review worker returned an unexpected response.');
  return response.draft;
}

export async function attributeReviewChangesInWorker(input: AttributionInput, versions: readonly AttributionVersion[], options: ReviewWorkerOptions = {}): Promise<ReadonlyMap<string, readonly AuthorIdentity[]>> {
  const response = await runReviewWorker({ type: 'attribute', input, versions }, options);
  if (response.type !== 'attribution') throw new Error('The review worker returned an unexpected response.');
  return new Map(response.attribution);
}

/** Runs one request on a dedicated worker; aborting terminates the worker so a runaway diff stops immediately. */
function runReviewWorker(request: DistributiveOmit<ReviewWorkerRequest, 'id'>, { signal, createWorker = defaultWorker }: ReviewWorkerOptions): Promise<Exclude<ReviewWorkerResponse, { type: 'error' }>> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const worker = createWorker();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const finish = () => { worker.terminate(); signal?.removeEventListener('abort', abort); };
    const abort = () => { finish(); reject(abortReason(signal!)); };
    signal?.addEventListener('abort', abort, { once: true });
    worker.addEventListener('message', (event: MessageEvent<ReviewWorkerResponse>) => {
      if (event.data.id !== id) return;
      finish();
      if (event.data.type === 'error') reject(Object.assign(new Error(event.data.error.message), { name: event.data.error.name }));
      else resolve(event.data);
    });
    worker.addEventListener('messageerror', () => { finish(); reject(new Error('The review worker sent a message that could not be read.')); });
    worker.addEventListener('error', (event) => { finish(); reject(new Error(event.message || 'The review worker stopped unexpectedly.')); });
    try { worker.postMessage({ ...request, id }); }
    catch (error) { finish(); reject(error); }
  });
}

function defaultWorker(): Worker { return new Worker(new URL('./review.worker.ts', import.meta.url), { type: 'module', name: 'markroot-review-diff' }); }
function abortReason(signal: AbortSignal): unknown { return signal.reason ?? new DOMException('Review cancelled.', 'AbortError'); }
