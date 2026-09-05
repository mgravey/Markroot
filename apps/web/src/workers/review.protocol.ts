import type { ReviewDraft } from '@markroot/review';

export interface ReviewWorkerRequest {
  readonly id: string;
  readonly base: string;
  readonly compare: string;
  readonly baseFingerprint: string;
}

export type ReviewWorkerResponse =
  | { readonly id: string; readonly type: 'result'; readonly draft: ReviewDraft }
  | { readonly id: string; readonly type: 'error'; readonly error: { readonly name: string; readonly message: string } };
