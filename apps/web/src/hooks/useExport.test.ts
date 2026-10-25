// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { workspacePath } from '@markroot/core';
import { DocumentSession } from '@markroot/document';
import { useExport } from './useExport.js';
import { deferred, mountHook } from './hook-test-utils.js';

const client = vi.hoisted(() => {
  function gate() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
  return { gate, started: gate(), ready: gate(), construct: vi.fn(), terminate: vi.fn(), export: vi.fn() };
});
vi.mock('../workers/export-client.js', async () => {
  client.started.resolve(); await client.ready.promise;
  return { WorkerExporter: class {
    constructor() { client.construct(); }
    export = client.export;
    terminate = client.terminate;
  } };
});
vi.mock('@markroot/export', () => ({ parseExportOptions: () => ({}) }));

beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); client.started = client.gate(); client.ready = client.gate(); });

function setup() {
  const options: Parameters<typeof useExport>[0] = {
    snapshot: new DocumentSession(workspacePath('a.md'), 'hello').snapshot(), workspace: undefined,
    justified: false, setNotice: vi.fn(), onWorkspaceChanged: vi.fn(),
  };
  return { options, hook: mountHook(useExport, options) };
}

it('cancels while export modules are loading without starting a worker', async () => {
  const { hook, options } = setup();
  let pending!: Promise<void>;
  try {
    expect(client.construct).not.toHaveBeenCalled();
    await act(async () => { pending = hook.current.exportDocument('html', 'download'); await client.started.promise; });
    await act(async () => { hook.current.cancel(); client.ready.resolve(); await pending; });
    expect(client.construct).not.toHaveBeenCalled(); expect(client.export).not.toHaveBeenCalled();
    expect(options.setNotice).toHaveBeenLastCalledWith('Export cancelled.'); expect(hook.current.busy).toBe(false);
  } finally { hook.unmount(); }
});

it('opens Save As synchronously, then loads the exporter and writes the selected file', async () => {
  client.ready.resolve();
  const { hook, options } = setup();
  const picker = deferred<FileSystemFileHandle>();
  const showSaveFilePicker = vi.fn(() => picker.promise);
  Object.assign(window, { showSaveFilePicker });
  const writable = { write: vi.fn(), close: vi.fn() };
  const blob = new Blob(['<p>hello</p>'], { type: 'text/html' });
  client.export.mockResolvedValue({ blob, filename: 'a.html', warnings: [] });
  try {
    await act(async () => {
      const pending = hook.current.exportDocument('html', 'save-as');
      expect(showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'a.html' }));
      expect(client.construct).not.toHaveBeenCalled();
      picker.resolve({ createWritable: async () => writable } as unknown as FileSystemFileHandle);
      await pending;
    });
    expect(client.export).toHaveBeenCalledOnce(); expect(writable.write).toHaveBeenCalledWith(blob);
    expect(writable.close).toHaveBeenCalledOnce(); expect(options.setNotice).toHaveBeenLastCalledWith('a.html is ready.');
    expect(hook.current.progress?.phase).toBe('complete');
  } finally { hook.unmount(); delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker; }
  expect(client.terminate).toHaveBeenCalledOnce();
});
