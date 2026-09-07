import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { workspacePath } from '@markroot/core';
import { listTree, MemoryWorkspace } from '@markroot/workspace';
import { CommentStore, commentRevision, createSelector, locateComments } from './index.js';

const path = workspacePath('paper.md');
const source = '# Title\n\nComment this prose.\n';
const range = { from: source.indexOf('this'), to: source.indexOf('this') + 4 };
const author = { actorId: 'ada', displayName: 'Ada', email: 'ada@example.test' };
async function fixture() {
  const workspace = new MemoryWorkspace({ [path]: source });
  const store = new CommentStore(workspace);
  const revision = await commentRevision(source, 'a'.repeat(40));
  const id = await store.create(path, source, range, 'First line\nSecond: # quoted "text"', author, revision);
  return { workspace, store, revision, id };
}
async function files(workspace: MemoryWorkspace): Promise<Record<string, string>> {
  const pairs = await Promise.all((await listTree(workspace)).filter((entry) => entry.kind === 'file').map(async (entry) => [entry.path, await workspace.readFile(entry.path)]));
  return Object.fromEntries(pairs);
}

describe('Git-friendly YAML comment storage', () => {
  it('keeps Markdown untouched and serializes readable multiline bodies', async () => {
    const { workspace, store, id } = await fixture();
    expect(await workspace.readFile(path)).toBe(source);
    const saved = await files(workspace);
    const message = Object.entries(saved).find(([file]) => file.includes('/messages/'))![1];
    expect(message).toContain('body: |-\n  First line\n  Second: # quoted "text"');
    expect(saved[`.markroot/comments/${id}/thread.yaml`]).not.toMatch(/messages:|updatedAt:/);
    expect((await store.load(path))[0]?.messages[0]?.body).toBe('First line\nSecond: # quoted "text"');
    expect(await store.load(workspacePath('another.md'))).toEqual([]);
  });

  it('round-trips multiline anchors as literal YAML blocks', async () => {
    const { store, workspace, revision } = await fixture();
    const id = await store.create(path, source, { from: 0, to: source.length }, 'Whole document', author, revision);
    const loaded = (await store.load(path)).find((thread) => thread.id === id)!;
    expect(loaded.selector.exact).toBe(source);
    expect(await workspace.readFile(workspacePath(`.markroot/comments/${id}/thread.yaml`))).toContain('exact: |');
  });

  it('adds concurrent replies in distinct files without mutating thread metadata', async () => {
    const { workspace, store, id } = await fixture();
    const before = await files(workspace);
    await Promise.all([store.reply(path, id, 'Reply A', author), new CommentStore(workspace).reply(path, id, 'Reply B', author)]);
    const after = await files(workspace);
    for (const [file, content] of Object.entries(before)) expect(after[file]).toBe(content);
    expect(Object.keys(after).length - Object.keys(before).length).toBe(2);
    expect((await store.load(path))[0]?.messages.map((message) => message.body)).toEqual(expect.arrayContaining(['Reply A', 'Reply B']));
  });

  it('stores revision-aware resolutions and uses deletion tombstones', async () => {
    const { workspace, store, id, revision } = await fixture();
    await store.setStatus(path, id, 'resolved', { revision, selector: createSelector(source, range), author, at: '2026-09-07T12:00:00Z' });
    expect((await store.load(path))[0]?.resolution?.revision).toEqual(revision);
    await store.setStatus(path, id, 'open');
    expect((await store.load(path))[0]?.resolution).toBeUndefined();
    await store.delete(path, id);
    expect(await store.load(path)).toEqual([]);
    expect(await store.paths(path)).toContain(`.markroot/comments/${id}/thread.yaml`);
    expect((await files(workspace))[`.markroot/comments/${id}/thread.yaml`]).toContain('deleted: true');
    await expect(store.reply(path, id, 'Late reply', author)).rejects.toThrow('not found');
  });

  it('reattaches explicitly without rewriting Markdown', async () => {
    const { workspace, store, id, revision } = await fixture();
    const changed = source.replace('this', 'that');
    await store.reattach(path, id, changed, range, revision);
    expect(locateComments(changed, await store.load(path)).orphans).toEqual([]);
    expect(await workspace.readFile(path)).toBe(source);
  });

  it('retries partial migration without duplicating messages or overwriting a newer resolution', async () => {
    const { store: original } = await fixture();
    const legacy = await original.load(path);
    const workspace = new MemoryWorkspace({ [path]: source });
    const store = new CommentStore(workspace);
    const revision = await commentRevision(source, null);
    const write = workspace.writeFileGuarded.bind(workspace);
    const spy = vi.spyOn(workspace, 'writeFileGuarded').mockImplementation(async (...args) => {
      if (args[0].endsWith('thread.yaml')) throw new Error('Disk full');
      return write(...args);
    });
    await expect(store.importLegacy(path, legacy, revision)).rejects.toThrow('Disk full');
    expect(await workspace.readFile(path)).toBe(source);
    spy.mockRestore();
    await store.importLegacy(path, legacy, revision);
    const id = legacy[0]!.id;
    await store.reply(path, id, 'Later reply', author);
    await store.setStatus(path, id, 'resolved', { revision, selector: legacy[0]!.selector, author, at: '2026-09-07' });
    await store.importLegacy(path, legacy, revision);
    const threads = await store.load(path);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.messages).toHaveLength(2);
    expect(threads[0]?.status).toBe('resolved');
    expect(threads[0]?.sourceRevision).toEqual(legacy[0]?.sourceRevision);
  });

  it('surfaces malformed YAML, merge conflicts and invalid IDs without overwriting them', async () => {
    const { workspace, store, id } = await fixture();
    const metadata = workspacePath(`.markroot/comments/${id}/thread.yaml`);
    await workspace.writeFile(metadata, '<<<<<<< HEAD\nstatus: open\n=======\nstatus: resolved\n>>>>>>> branch\n');
    await expect(store.load(path)).rejects.toThrow(/YAML|merge conflict/);
    await expect(store.setStatus(path, id, 'open')).rejects.toThrow();
    await expect(store.reply(path, '../escape', 'unsafe', author)).rejects.toThrow('Invalid comment ID');
    expect(await workspace.readFile(metadata)).toContain('<<<<<<< HEAD');
  });
});


it('merges real Git branches with independent replies, inherited threads and revision-aware resolutions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'markroot-comment-merge-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.test', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.test' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const persist = async (workspace: MemoryWorkspace) => {
    for (const [path, content] of Object.entries(await files(workspace))) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), content);
    }
  };
  const checkoutWorkspace = async () => new MemoryWorkspace(Object.fromEntries(await Promise.all(git('ls-files', '-z').split('\0').filter(Boolean).map(async (path) => [path, await readFile(join(directory, path), 'utf8')]))));
  try {
    const { workspace, id, revision } = await fixture();
    git('init', '-b', 'main');
    await persist(workspace);
    git('add', '.'); git('commit', '-m', 'Initial paper and comment');
    git('checkout', '-b', 'reviewer-a');
    const a = new CommentStore(workspace);
    await a.reply(path, id, 'Reply from A', author);
    await a.setStatus(path, id, 'resolved', { revision, selector: createSelector(source, range), author, at: '2026-09-07' });
    const onlyA = await a.create(path, source, range, 'Thread from A', author, revision);
    await persist(workspace);
    git('add', '.'); git('commit', '-m', 'Review A');

    git('checkout', 'main');
    const mainWorkspace = await checkoutWorkspace();
    const main = new CommentStore(mainWorkspace);
    expect((await main.load(path)).map((thread) => thread.id)).toEqual([id]);
    expect((await main.load(path))[0]?.status).toBe('open');
    await main.reply(path, id, 'Reply from main', author);
    await mainWorkspace.writeFile(path, source.replace('prose', 'claim'));
    await persist(mainWorkspace);
    git('add', '.'); git('commit', '-m', 'Review main and revise context');
    git('merge', 'reviewer-a', '--no-edit');

    const merged = await checkoutWorkspace();
    const threads = await new CommentStore(merged).load(path);
    expect(threads.map((thread) => thread.id)).toContain(onlyA);
    const inherited = threads.find((thread) => thread.id === id)!;
    expect(inherited.messages.map((message) => message.body)).toEqual(expect.arrayContaining(['Reply from A', 'Reply from main']));
    expect(inherited.messages).toHaveLength(3);
    expect(inherited.status).toBe('resolved');
    expect(locateComments(await merged.readFile(path), threads).needsReview).toContain(id);
    expect(await merged.readFile(path)).not.toContain('markroot:');
    expect(git('status', '--porcelain')).toBe('');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
