import type { AuthorIdentity } from '@markroot/core';
import type { ReviewDraft } from '@markroot/review';
import type { AttributionInput, AttributionVersion } from '../review-attribution.js';

export type ReviewWorkerRequest =
  | { readonly type: 'draft'; readonly id: string; readonly base: string; readonly compare: string; readonly baseFingerprint: string }
  | { readonly type: 'attribute'; readonly id: string; readonly input: AttributionInput; readonly versions: readonly AttributionVersion[] };

export type ReviewWorkerResponse =
  | { readonly id: string; readonly type: 'result'; readonly draft: ReviewDraft }
  | { readonly id: string; readonly type: 'attribution'; readonly attribution: readonly (readonly [id: string, authors: readonly AuthorIdentity[]])[] }
  | { readonly id: string; readonly type: 'error'; readonly error: { readonly name: string; readonly message: string } };
