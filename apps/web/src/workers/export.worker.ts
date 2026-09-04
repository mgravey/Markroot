/// <reference lib="webworker" />
import { BrowserDocumentExporter } from '@markroot/export';
import type { ExportWorkerRequest, ExportWorkerResponse } from './export.protocol.js';

const exporter = new BrowserDocumentExporter();
const operations = new Map<string, AbortController>();

self.addEventListener('message', (event: MessageEvent<ExportWorkerRequest>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    operations.get(message.id)?.abort();
    return;
  }
  const controller = new AbortController();
  operations.set(message.id, controller);
  void exporter.export(message.request, {
    signal: controller.signal,
    onProgress: (progress) => respond({ type: 'progress', id: message.id, progress }),
  }).then((result) => respond({ type: 'result', id: message.id, result }))
    .catch((error: unknown) => respond({
      type: 'error',
      id: message.id,
      error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) },
    }))
    .finally(() => operations.delete(message.id));
});

function respond(message: ExportWorkerResponse): void { self.postMessage(message); }
