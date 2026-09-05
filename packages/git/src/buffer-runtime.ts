import { Buffer as BrowserBuffer } from 'buffer';

type BufferRuntime = typeof globalThis & { Buffer?: typeof BrowserBuffer };

/** isomorphic-git's ESM build expects a global Node-compatible Buffer in browsers. */
export function ensureGitBuffer(runtime: BufferRuntime = globalThis): void {
  if (!runtime.Buffer) runtime.Buffer = BrowserBuffer;
}

ensureGitBuffer();
