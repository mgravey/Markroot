import { describe, expect, it } from 'vitest';
import { MemoryWorkspace } from '@markroot/workspace';
import type { WorkspacePath } from '@markroot/core';
import { documentEntries } from './useWorkspaceDocuments.js';

describe('documentEntries', () => {
  it('walks folders concurrently, skips tool directories and returns a sorted tree', async () => {
    const workspace = new MemoryWorkspace();
    for (const path of ['paper.qmd', 'figures/a.png', 'data/2024/x.csv', 'data/2025/y.csv', '.git/HEAD', 'node_modules/pkg/index.js', 'notes/.quarto/cache']) await workspace.writeFile(path as WorkspacePath, 'x');
    let inFlight = 0;
    let peak = 0;
    const listFiles = workspace.listFiles.bind(workspace);
    workspace.listFiles = async (path?: WorkspacePath) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try { return await listFiles(path); } finally { inFlight--; }
    };
    const entries = await documentEntries(workspace, 4);
    expect(entries.map((entry) => entry.path)).toEqual(['data', 'data/2024', 'data/2024/x.csv', 'data/2025', 'data/2025/y.csv', 'figures', 'figures/a.png', 'notes', 'paper.qmd']);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('propagates listing failures', async () => {
    const workspace = new MemoryWorkspace();
    workspace.listFiles = () => Promise.reject(new DOMException('closed', 'AbortError'));
    await expect(documentEntries(workspace)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
