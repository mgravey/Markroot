import { describe, expect, it } from 'vitest';
import { UndoTree, applyHistoryEdits, contentHash, textEdit } from './tree.js';

const record = (tree: UndoTree, text: string, time = 0, origin = 'source') => tree.record(textEdit(tree.text, text), { origin, time });
function fork() {
  const tree = new UndoTree('root');
  const first = record(tree, 'first', 1000);
  tree.undo(); const second = record(tree, 'second', 1100);
  return { tree, first, second };
}

describe('undo tree', () => {
  it('branches after undo without losing either future, including rapid typing', () => {
    const { tree, first, second } = fork();
    expect(tree.siblings().map((node) => node.id)).toEqual([first, second]);
    expect(tree.size).toBe(3);
    expect(tree.textAt(first)).toBe('first');
    expect(tree.text).toBe('second');
    tree.undo(); tree.redo(); expect(tree.currentId).toBe(second);
    tree.checkout(first); tree.undo(); tree.redo(); expect(tree.currentId).toBe(first);
  });
  it('returns replayable exact edits across a common ancestor and selects last-visited branches', () => {
    const { tree, first, second } = fork();
    const deep = record(tree, 'second\nlast', 4000);
    const before = tree.text;
    expect(applyHistoryEdits(before, tree.checkout(first))).toBe('first');
    expect(applyHistoryEdits(tree.text, tree.checkout(deep))).toBe('second\nlast');
    tree.undo(); expect(tree.currentId).toBe(second);
    tree.undo(); tree.redo(); expect(tree.currentId).toBe(second);
    tree.redo(); expect(tree.currentId).toBe(deep);
  });
  it('cycles siblings and the last active descendants at the closest fork', () => {
    const { tree, first, second } = fork();
    const deep = record(tree, 'second!', 4000);
    expect(tree.branchPosition()).toEqual({ index: 2, count: 2 });
    tree.prevBranch(); expect(tree.currentId).toBe(first);
    tree.nextBranch(); expect(tree.currentId).toBe(deep);
    expect(tree.get(second).lastActiveChild).toBe(deep);
  });
  it('groups contiguous insertions/deletions for 800 ms and preserves the inverse', () => {
    const tree = new UndoTree('');
    const id = record(tree, 'a', 1000);
    expect(record(tree, 'ab', 1500)).toBe(id);
    expect(record(tree, 'abc', 2200)).toBe(id);
    record(tree, 'ab', 2300); expect(tree.size).toBe(2);
    expect(applyHistoryEdits(tree.text, tree.undo())).toBe('');
    tree.redo(); expect(tree.text).toBe('ab');
  });
  it('splits groups on delay, origin, nonadjacent edits, navigation, stars and forks', () => {
    const tree = new UndoTree('ab');
    record(tree, 'abc', 0); record(tree, 'abcd', 801); expect(tree.size).toBe(3);
    record(tree, 'abcde', 802, 'visual'); expect(tree.size).toBe(4);
    record(tree, 'zabcde', 803, 'visual'); expect(tree.size).toBe(5);
    const starred = tree.currentId; tree.star(starred);
    record(tree, 'zzabcde', 804, 'visual'); expect(tree.size).toBe(6);
    tree.undo(); const branch = record(tree, 'yabcde', 805, 'visual');
    record(tree, 'yyabcde', 806, 'visual'); expect(tree.currentId).toBe(branch);
    expect(tree.get(starred).children).toHaveLength(2);
    expect(tree.textAt(starred)).toBe('zabcde');
    tree.checkout(branch); record(tree, 'yyyabcde', 807, 'visual'); expect(tree.currentId).not.toBe(branch);
  });
  it('does not group review/system changes or record no-ops', () => {
    const tree = new UndoTree('a'); record(tree, 'a'); expect(tree.size).toBe(1);
    record(tree, 'ab', 0, 'review'); record(tree, 'abc', 1, 'review'); expect(tree.size).toBe(3);
  });
  it('matches external text exactly, or attaches a checkpoint child', () => {
    const { tree, first, second } = fork();
    tree.attachExternal('first'); expect(tree.currentId).toBe(first); expect(tree.size).toBe(3);
    const id = tree.attachExternal('disk'); expect(tree.get(id)).toMatchObject({ origin: 'external', checkpoint: 'disk', parentId: first });
    tree.checkout(second); expect(tree.text).toBe('second');
  });
  it('round trips IDs, stars, branches, last-active children and checkpoints', () => {
    const { tree, first, second } = fork(); tree.star(first); tree.checkout(first);
    const data = JSON.parse(JSON.stringify(tree.toJSON())) as unknown;
    const restored = UndoTree.fromJSON(data);
    expect(restored.toJSON()).toEqual(tree.toJSON());
    restored.checkout(second); restored.undo(); restored.redo(); expect(restored.currentId).toBe(second);
    expect(restored.get(first).starred).toBe(true);
    expect(record(restored, 'second!', 4000)).not.toBe(second);
  });
  it('rejects corrupt, detached, cyclic, oversized and incompatible trees', () => {
    const { tree } = fork(); const data = tree.toJSON();
    expect(() => UndoTree.fromJSON({ ...data, version: 2 })).toThrow();
    expect(() => UndoTree.fromJSON({ ...data, currentId: 'missing' })).toThrow();
    data.nodes[1]!.hash = contentHash('bad'); expect(() => UndoTree.fromJSON(data)).toThrow();
    const cycle = tree.toJSON(); cycle.nodes[0]!.children.push('h0'); expect(() => UndoTree.fromJSON(cycle)).toThrow();
    expect(() => UndoTree.fromJSON(tree.toJSON(), { maxBytes: 1 })).toThrow();
    const detached = tree.toJSON(); detached.nodes[0]!.children = []; expect(() => UndoTree.fromJSON(detached)).toThrow();
  });
  it('drops oldest unprotected leaves while keeping current and starred paths', () => {
    const tree = new UndoTree('root', { maxNodes: 5 });
    const keep = record(tree, 'keep'); tree.star(keep);
    tree.undo(); const old = record(tree, 'old', 1000); record(tree, 'old2', 2000);
    tree.checkout(tree.rootId); const current = record(tree, 'new', 3000); record(tree, 'new2', 4000);
    tree.prune();
    expect(tree.size).toBeLessThanOrEqual(5);
    expect(tree.textAt(keep)).toBe('keep'); expect(tree.path()).toContain(current); expect(tree.text).toBe('new2');
    expect(tree.allNodes.some((node) => node.id === old)).toBe(false);
    expect(() => UndoTree.fromJSON(tree.toJSON())).not.toThrow();
  });
  it('compacts long active runs into checkpoints, preserving starred/current versions', () => {
    const tree = new UndoTree('root', { maxNodes: 4 });
    const starred = record(tree, 'starred', 1000); tree.star(starred);
    for (let i = 2; i <= 20; i += 1) record(tree, String(i), i * 1000);
    expect(tree.size).toBeLessThanOrEqual(4); expect(tree.textAt(starred)).toBe('starred'); expect(tree.text).toBe('20');
    const restored = UndoTree.fromJSON(tree.toJSON()); restored.undo(); expect(restored.text).toBe('19');
    restored.checkout(starred); expect(restored.text).toBe('starred');
  });
  it('creates periodic checkpoints and supports sequential batch edits', () => {
    const tree = new UndoTree('a', { checkpointEvery: 2 });
    record(tree, 'ab', 1000); record(tree, 'abc', 2000); expect(tree.current.checkpoint).toBe('abc');
    tree.record([{ from: 0, to: 1, insert: 'A' }, { from: 3, to: 3, insert: 'D' }], { origin: 'review' });
    expect(tree.text).toBe('AbcD'); tree.undo(); expect(tree.text).toBe('abc');
  });
  it('keeps CRLF, lone CR, Unicode and surrogate pairs exact across edits and JSON', () => {
    const source = '👩🏽‍💻 café\r\n日本語\rfin'; const tree = new UndoTree(source);
    const target = '👩🏻‍💻 cafe\u0301\r\n日本語\rfin🙂';
    record(tree, target); expect(tree.text).toBe(target);
    const restored = UndoTree.fromJSON(tree.toJSON()); restored.undo(); expect(restored.text).toBe(source);
    expect(applyHistoryEdits(source, restored.redo())).toBe(target);
  });
  it('validates edit ranges', () => { expect(() => applyHistoryEdits('a', [{ from: -1, to: 0, insert: '' }])).toThrow(); });
});
