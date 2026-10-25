import { describe, expect, it, vi } from 'vitest';
import { attributeReviewChangesInWorker, createReviewDraftInWorker } from './review-client.js';

class FakeWorker extends EventTarget {
  posted: unknown[] = [];
  terminate = vi.fn();
  postMessage(message: unknown) { this.posted.push(message); }
  reply(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data })); }
}
const fake = () => { const worker = new FakeWorker(); return { worker, createWorker: () => worker as unknown as Worker }; };
const idOf = (worker: FakeWorker) => (worker.posted[0] as { id: string }).id;

describe('review worker client', () => {
  it('resolves drafts and terminates the worker', async () => {
    const { worker, createWorker } = fake();
    const result = createReviewDraftInWorker('a', 'b', 'fp', { createWorker });
    expect(worker.posted[0]).toMatchObject({ type: 'draft', base: 'a', compare: 'b', baseFingerprint: 'fp' });
    worker.reply({ id: 'other', type: 'result', draft: {} });
    worker.reply({ id: idOf(worker), type: 'result', draft: { changes: [] } });
    await expect(result).resolves.toEqual({ changes: [] });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('terminates the worker when aborted', async () => {
    const { worker, createWorker } = fake();
    const controller = new AbortController();
    const result = createReviewDraftInWorker('a', 'b', 'fp', { createWorker, signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('does not start a worker for an already aborted signal', async () => {
    const createWorker = vi.fn();
    await expect(createReviewDraftInWorker('a', 'b', 'fp', { createWorker, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('rejects on messageerror and worker errors', async () => {
    const first = fake();
    const unreadable = createReviewDraftInWorker('a', 'b', 'fp', { createWorker: first.createWorker });
    first.worker.dispatchEvent(new Event('messageerror'));
    await expect(unreadable).rejects.toThrow(/could not be read/);
    const second = fake();
    const failed = attributeReviewChangesInWorker({ base: '', compare: '', changes: [] }, [], { createWorker: second.createWorker });
    second.worker.reply({ id: idOf(second.worker), type: 'error', error: { name: 'RangeError', message: 'boom' } });
    await expect(failed).rejects.toMatchObject({ name: 'RangeError', message: 'boom' });
  });

  it('terminates an attribution worker on abort and ignores a late response', async () => {
    const { worker, createWorker } = fake();
    const controller = new AbortController();
    const result = attributeReviewChangesInWorker({ base: '', compare: '', changes: [] }, [], { createWorker, signal: controller.signal });
    controller.abort(new DOMException('Superseded', 'AbortError'));
    await expect(result).rejects.toThrow('Superseded');
    worker.reply({ id: idOf(worker), type: 'attribution', attribution: [] });
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('terminates when posting the request throws', async () => {
    const { worker, createWorker } = fake();
    vi.spyOn(worker, 'postMessage').mockImplementation(() => { throw new DOMException('Cannot clone', 'DataCloneError'); });
    await expect(createReviewDraftInWorker('', '', 'fp', { createWorker })).rejects.toThrow('Cannot clone');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('returns attribution as a map', async () => {
    const { worker, createWorker } = fake();
    const result = attributeReviewChangesInWorker({ base: '', compare: '', changes: [] }, [], { createWorker });
    worker.reply({ id: idOf(worker), type: 'attribution', attribution: [['c1', [{ displayName: 'A' }]]] });
    expect((await result).get('c1')).toEqual([{ displayName: 'A' }]);
  });
});
