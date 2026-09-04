import type { OperationContext } from '@markroot/core';
import type { ExportFormat, Exporter, ExportRequest, ExportResult } from '@markroot/export';
import type { ExportWorkerRequest, ExportWorkerResponse } from './export.protocol.js';

interface PendingExport {
  readonly resolve: (result: ExportResult) => void;
  readonly reject: (error: Error) => void;
  readonly context?: OperationContext;
  readonly cleanup?: () => void;
}

export class WorkerExporter implements Exporter {
  readonly formats: readonly ExportFormat[] = ['html', 'docx', 'pdf'];
  private worker: Worker;
  private readonly pending = new Map<string, PendingExport>();
  private stopped = false;

  constructor() {
    this.worker = this.createWorker();
  }

  export(request: ExportRequest, context?: OperationContext): Promise<ExportResult> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.worker.terminate();
        if (!this.stopped) this.worker = this.createWorker();
        this.pending.delete(id);
        reject(new DOMException('Export cancelled.', 'AbortError'));
      };
      context?.signal?.addEventListener('abort', abort, { once: true });
      const cleanup = context?.signal ? () => context.signal?.removeEventListener('abort', abort) : undefined;
      this.pending.set(id, { resolve, reject, ...(context ? { context } : {}), ...(cleanup ? { cleanup } : {}) });
      this.worker.postMessage({ type: 'export', id, request } satisfies ExportWorkerRequest);
    });
  }

  terminate(): void {
    this.stopped = true;
    this.worker.terminate();
    for (const item of this.pending.values()) item.reject(new Error('Export worker terminated.'));
    this.pending.clear();
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module', name: 'markroot-export' });
    worker.addEventListener('message', (event: MessageEvent<ExportWorkerResponse>) => this.receive(event.data));
    worker.addEventListener('error', (event) => {
      for (const item of this.pending.values()) item.reject(new Error(event.message || 'The export worker stopped unexpectedly.'));
      this.pending.clear();
      worker.terminate();
      if (!this.stopped) this.worker = this.createWorker();
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
