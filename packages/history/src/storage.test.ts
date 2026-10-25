import { describe, expect, it } from 'vitest';
import { UndoTree } from './tree.js';
import { historyKey, loadHistory, saveHistory, type HistoryBackend, type HistoryJSON } from './index.js';

describe('history storage', () => {
  it('scopes unambiguous keys per project and path', () => {
    expect(historyKey('a/b', 'c')).not.toBe(historyKey('a', 'b/c'));
    expect(historyKey('one', 'a.md')).not.toBe(historyKey('two', 'a.md'));
  });
  it('serializes writes and waits for pending saves before loading', async () => {
    let release!: () => void; let value: HistoryJSON | undefined;
    const pause = new Promise<void>((resolve) => { release = resolve; }); let calls = 0;
    const backend: HistoryBackend = { load: () => Promise.resolve(value), save: async (_key, data) => { if (++calls === 1) await pause; value = data; } };
    const tree = new UndoTree('a'); const first = saveHistory(backend, 'key', tree);
    tree.record({ from: 1, to: 1, insert: 'b' }, { origin: 'source' }); const second = saveHistory(backend, 'key', tree);
    const loaded = loadHistory(backend, 'key'); release(); await Promise.all([first, second]);
    expect(UndoTree.fromJSON(await loaded).text).toBe('ab');
  });
});
