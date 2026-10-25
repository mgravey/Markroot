import { describe, expect, it } from 'vitest';
import type { ExportWorkerRequest, ExportWorkerResponse } from './export.protocol.js';
import { WorkerExporter } from './export-client.js';

class FakeWorker extends EventTarget {
  readonly posted: ExportWorkerRequest[] = [];
  terminated = false;
  postMessage(message: ExportWorkerRequest) { this.posted.push(message); }
  terminate() { this.terminated = true; }
  reply(data: ExportWorkerResponse) { this.dispatchEvent(new MessageEvent('message', { data })); }
}

function harness() {
  const workers: FakeWorker[] = [];
  const exporter = new WorkerExporter(() => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; });
  return { exporter, workers };
}

const request = { format: 'html', source: '# Title', filename: 'doc.html' } as const;
const result = (worker: FakeWorker, index = 0) => ({ format: 'html', blob: new Blob(['ok']), filename: 'doc.html', warnings: [], id: worker.posted[index]!.id });

describe('WorkerExporter', () => {
  it('creates its worker lazily on the first export', async () => {
    const { exporter, workers } = harness();
    expect(workers).toHaveLength(0);
    const pending = exporter.export(request);
    const worker = workers[0]!;
    const { id, ...payload } = result(worker);
    worker.reply({ type: 'result', id, result: payload as never });
    await expect(pending).resolves.toMatchObject({ filename: 'doc.html' });
  });

  it('keeps working after terminate (React StrictMode effect cleanup)', async () => {
    const { exporter, workers } = harness();
    const first = exporter.export(request);
    exporter.terminate();
    await expect(first).rejects.toThrow('terminated');
    expect(workers[0]!.terminated).toBe(true);
    const second = exporter.export(request);
    expect(workers).toHaveLength(2);
    const { id, ...payload } = result(workers[1]!);
    workers[1]!.reply({ type: 'result', id, result: payload as never });
    await expect(second).resolves.toMatchObject({ format: 'html' });
  });

  it('cancels without stranding other exports that share the worker', async () => {
    const { exporter, workers } = harness();
    const controller = new AbortController();
    const cancelled = exporter.export(request, { signal: controller.signal });
    const kept = exporter.export(request);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0]!.terminated).toBe(false);
    const { id: _ignored, ...payload } = result(workers[0]!);
    workers[0]!.reply({ type: 'result', id: workers[0]!.posted[1]!.id, result: payload as never });
    await expect(kept).resolves.toMatchObject({ format: 'html' });
  });

  it('stops a lone cancelled conversion and recovers from worker crashes', async () => {
    const { exporter, workers } = harness();
    const controller = new AbortController();
    const cancelled = exporter.export(request, { signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0]!.terminated).toBe(true);
    const crashed = exporter.export(request);
    workers[1]!.dispatchEvent(Object.assign(new Event('error'), { message: 'boom' }));
    await expect(crashed).rejects.toThrow('boom');
    void exporter.export(request);
    expect(workers).toHaveLength(3);
  });
});
