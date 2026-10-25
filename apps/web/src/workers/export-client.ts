import type { OperationContext } from '@markroot/core';
import type { ExportFormat, Exporter, ExportRequest, ExportResult } from '@markroot/export';
import type { ExportWorkerRequest, ExportWorkerResponse } from './export.protocol.js';

interface PendingExport {
  readonly resolve: (result: ExportResult) => void;
  readonly reject: (error: Error) => void;
  readonly context?: OperationContext;
  readonly cleanup?: () => void;
}

export type ExportWorkerFactory = () => Worker;

const spawnExportWorker: ExportWorkerFactory = () => new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module', name: 'markroot-export' });

/**
 * Runs exports in a lazily created worker. terminate() only stops the current worker: the next export spawns a
 * fresh one, so React StrictMode's dev-only effect cleanup cannot leave later exports hanging.
 */
export class WorkerExporter implements Exporter {
  readonly formats: readonly ExportFormat[] = ['html', 'docx', 'pdf'];
  private worker: Worker | undefined;
  private readonly pending = new Map<string, PendingExport>();

  constructor(private readonly spawn: ExportWorkerFactory = spawnExportWorker) {}

  export(request: ExportRequest, context?: OperationContext): Promise<ExportResult> {
    if (context?.signal?.aborted) return Promise.reject(context.signal.reason ?? new DOMException('Export cancelled.', 'AbortError'));
    const id = crypto.randomUUID();
    const worker = this.worker ??= this.createWorker();
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        // Stop the conversion only when nothing else shares this worker; otherwise its late reply is simply ignored.
        if (this.worker === worker && this.pending.size === 0) this.stopWorker();
        reject(new DOMException('Export cancelled.', 'AbortError'));
      };
      context?.signal?.addEventListener('abort', abort, { once: true });
      const cleanup = context?.signal ? () => context.signal?.removeEventListener('abort', abort) : undefined;
      this.pending.set(id, { resolve, reject, ...(context ? { context } : {}), ...(cleanup ? { cleanup } : {}) });
      worker.postMessage({ type: 'export', id, request } satisfies ExportWorkerRequest);
    });
  }

  terminate(): void {
    this.stopWorker();
    this.rejectAll(new Error('Export worker terminated.'));
  }

  private stopWorker(): void {
    this.worker?.terminate();
    this.worker = undefined;
  }

  private rejectAll(error: Error): void {
    const items = [...this.pending.values()];
    this.pending.clear();
    for (const item of items) { item.cleanup?.(); item.reject(error); }
  }

  private createWorker(): Worker {
    const worker = this.spawn();
    worker.addEventListener('message', (event: MessageEvent<ExportWorkerResponse>) => { if (this.worker === worker) this.receive(event.data); });
    worker.addEventListener('error', (event) => {
      if (this.worker !== worker) return;
      this.stopWorker();
      this.rejectAll(new Error(event.message || 'The export worker stopped unexpectedly.'));
    });
    return worker;
  }

  private receive(message: ExportWorkerResponse): void {
    const item = this.pending.get(message.id);
    if (!item) return;
    if (message.type === 'progress') { item.context?.onProgress?.(message.progress); return; }
    item.cleanup?.();
    this.pending.delete(message.id);
    if (message.type === 'result') item.resolve(message.result);
    else item.reject(Object.assign(new Error(message.error.message), { name: message.error.name }));
  }
}
