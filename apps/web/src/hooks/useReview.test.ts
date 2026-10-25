// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { workspacePath } from '@markroot/core';
import { DocumentSession } from '@markroot/document';
import { createReviewDraftInWorker } from '../workers/review-client.js';
import { ScrollStore } from './scroll-store.js';
import { useReview } from './useReview.js';
import { deferred, mountHook } from './hook-test-utils.js';

vi.mock('../workers/review-client.js', () => ({ createReviewDraftInWorker: vi.fn(), attributeReviewChangesInWorker: vi.fn() }));

function setup() {
  const options: Parameters<typeof useReview>[0] = {
    git: { readFileAtRef: vi.fn().mockResolvedValue('text'), fingerprint: vi.fn().mockResolvedValue('fp') } as unknown as Parameters<typeof useReview>[0]['git'],
    workspace: undefined, snapshot: new DocumentSession(workspacePath('a.md'), 'text').snapshot(), scroll: new ScrollStore(),
    setSelection: vi.fn(), setSourceCursorTarget: vi.fn(), applySource: vi.fn(), setNotice: vi.fn(), reportError: vi.fn(), onOpened: vi.fn(), onApplied: vi.fn(),
  };
  return { hook: mountHook(useReview, options), options };
}

describe('review lifecycle', () => {
  it('aborts the previous worker comparison and cancels outstanding work on unmount', async () => {
    const started = [deferred<AbortSignal>(), deferred<AbortSignal>()];
    let index = 0;
    vi.mocked(createReviewDraftInWorker).mockImplementation((_base, _compare, _fingerprint, options) => new Promise((_resolve, reject) => {
      const signal = options!.signal!;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      started[index++]!.resolve(signal);
    }));
    const { hook, options } = setup();
    const first = hook.current.compare('first');
    const firstSignal = await started[0]!.promise;
    const second = hook.current.compare('second');
    const secondSignal = await started[1]!.promise;
    expect(firstSignal.aborted).toBe(true);
    hook.unmount();
    expect(secondSignal.aborted).toBe(true);
    await Promise.all([first, second]);
    expect(options.reportError).not.toHaveBeenCalled();
    expect(options.onOpened).not.toHaveBeenCalled();
  });

  it('reports too-large comparisons before considering an empty changes array', async () => {
    vi.mocked(createReviewDraftInWorker).mockResolvedValue({ tooLarge: true, changes: [] } as unknown as Awaited<ReturnType<typeof createReviewDraftInWorker>>);
    const { hook, options } = setup();
    await act(async () => { await hook.current.compare('large'); });
    expect(options.setNotice).toHaveBeenLastCalledWith(expect.stringContaining('too large to review inline'));
    expect(options.onOpened).not.toHaveBeenCalled();
    hook.unmount();
  });
});
