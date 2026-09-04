import type { ExportRequest, ExportResult } from '@markroot/export';
import type { ProgressEvent } from '@markroot/core';

export type ExportWorkerRequest =
  | { readonly type: 'export'; readonly id: string; readonly request: ExportRequest }
  | { readonly type: 'cancel'; readonly id: string };

export type ExportWorkerResponse =
  | { readonly type: 'progress'; readonly id: string; readonly progress: ProgressEvent }
  | { readonly type: 'result'; readonly id: string; readonly result: ExportResult }
  | { readonly type: 'error'; readonly id: string; readonly error: { readonly name: string; readonly message: string } };
