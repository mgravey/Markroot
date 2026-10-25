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
    const metadata = (await files(workspace))[`.markroot/comments/${id}/thread.yaml`];
    await store.delete(path, id);
    expect(await store.load(path)).toEqual([]);
    const saved = await files(workspace);
    // State changes are append-only events; thread.yaml never changes after creation.
    expect(saved[`.markroot/comments/${id}/thread.yaml`]).toBe(metadata);
    const events = Object.keys(saved).filter((file) => file.startsWith(`.markroot/comments/${id}/events/`));
    expect(events).toHaveLength(3);
    expect(events.some((file) => saved[file]!.includes('type: "delete"'))).toBe(true);
    expect(await store.paths(path)).toEqual(expect.arrayContaining([`.markroot/comments/${id}/thread.yaml`, ...events]));
    await expect(store.reply(path, id, 'Late reply', author)).rejects.toThrow('not found');
  });

  it.each(['tie', 'clock skew'])('keeps resolve then reopen causal under %s', async (clock) => {
    const { workspace, store, id, revision } = await fixture();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
      const uuid = vi.spyOn(crypto, 'randomUUID');
      uuid.mockReturnValueOnce('ffffffff-ffff-4fff-afff-ffffffffffff');
      await store.setStatus(path, id, 'resolved', { revision, selector: createSelector(source, range), author, at: 'now' });
      if (clock === 'clock skew') vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
      uuid.mockReturnValueOnce('00000000-0000-4000-a000-000000000000');
      await new CommentStore(workspace).setStatus(path, id, 'open');
      expect((await new CommentStore(workspace).load(path))[0]?.status).toBe('open');
      const events = Object.entries(await files(workspace)).filter(([file]) => file.includes('/events/'));
      expect(events.map(([, content]) => /seq: (\d+)/.exec(content)?.[1]).sort()).toEqual(['1', '2']);
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });

  it('orders unsequenced intermediate events by time, then extends them with a logical clock', async () => {
    const { workspace, store, id, revision } = await fixture();
    await store.setStatus(path, id, 'resolved', { revision, selector: createSelector(source, range), author, at: 'now' });
    await store.setStatus(path, id, 'open');
    const events = (await listTree(workspace)).filter((entry) => entry.path.includes('/events/'));
    for (const event of events) {
      const content = await workspace.readFile(event.path);
      const at = content.includes('type: "resolve"') ? '2030-01-01T00:00:00.000Z' : '2029-01-01T00:00:00.000Z';
      await workspace.writeFile(event.path, content.replace(/^seq: .*\n/m, '').replace(/^at: .*$/m, `at: "${at}"`));
    }
    expect((await new CommentStore(workspace).load(path))[0]?.status).toBe('resolved');
    await store.setStatus(path, id, 'open');
    expect((await new CommentStore(workspace).load(path))[0]?.status).toBe('open');
  });

  it('folds merged concurrent sequences deterministically and advances past every known event', async () => {
    const { workspace, id, revision } = await fixture();
    const seed = await files(workspace);
    const a = new MemoryWorkspace(seed);
    const b = new MemoryWorkspace(seed);
    const resolution = { revision, selector: createSelector(source, range), author, at: 'now' };
    await new CommentStore(a).setStatus(path, id, 'resolved', resolution);
    await new CommentStore(b).setStatus(path, id, 'open');
    const merged = { ...await files(a), ...await files(b) };
    const forward = new MemoryWorkspace(merged);
    const reverse = new MemoryWorkspace(Object.fromEntries(Object.entries(merged).reverse()));
    const first = await new CommentStore(forward).load(path);
    expect(await new CommentStore(reverse).load(path)).toEqual(first);
    await new CommentStore(forward).setStatus(path, id, 'resolved', resolution);
    const saved = Object.entries(await files(forward)).filter(([file]) => file.includes('/events/'));
    expect(saved.filter(([, content]) => content.includes('seq: 1'))).toHaveLength(2);
    expect(saved.filter(([, content]) => content.includes('seq: 2'))).toHaveLength(1);
    expect((await new CommentStore(forward).load(path))[0]?.status).toBe('resolved');
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
    const healthy = await store.create(path, source, range, 'Healthy thread', author, (await store.load(path))[0]!.sourceRevision!);
    await workspace.writeFile(metadata, '<<<<<<< HEAD\nstatus: open\n=======\nstatus: resolved\n>>>>>>> branch\n');
    // One broken sidecar must not hide every other thread of every document.
    expect((await store.load(path)).map((thread) => thread.id)).toEqual([healthy]);
    const { broken } = await store.loadWithIssues(path);
    expect(broken).toEqual([{ id, error: expect.stringMatching(/YAML|merge conflict/) }]);
    expect(await store.paths(path)).not.toContain(metadata);
    await expect(store.setStatus(path, id, 'open')).rejects.toThrow();
    await expect(store.reply(path, '../escape', 'unsafe', author)).rejects.toThrow('Invalid comment ID');
    expect(await workspace.readFile(metadata)).toContain('<<<<<<< HEAD');
  });

  it('reports broken messages per thread and reuses parsed sidecars until they change', async () => {
    const { workspace, store, id } = await fixture();
    await store.reply(path, id, 'Second', author);
    await store.load(path);
    const read = vi.spyOn(workspace, 'readFile');
    await store.load(path);
    expect(read).not.toHaveBeenCalled();
    const message = (await listTree(workspace)).find((entry) => entry.path.includes('/messages/'))!.path;
    await workspace.writeFile(message, 'body: [unterminated\n');
    read.mockClear();
    const result = await store.loadWithIssues(path);
    expect(read.mock.calls.map(([file]) => file)).toEqual([message]);
    expect(result).toMatchObject({ threads: [], broken: [{ id, document: path }] });
  });

  it('folds legacy thread.yaml state with later events', async () => {
    const { workspace, store, id, revision } = await fixture();
    const metadata = workspacePath(`.markroot/comments/${id}/thread.yaml`);
    const resolution = { revision, selector: createSelector(source, range), author, at: '2026-01-01T00:00:00Z' };
    const legacy = (await workspace.readFile(metadata)).replace('status: "open"', 'status: "resolved"');
    await workspace.writeFile(metadata, legacy.replace('resolution: null', `resolution:\n  revision:\n    commit: "${revision.commit}"\n    contentHash: "${revision.contentHash}"\n  selector:\n    from: ${range.from}\n    to: ${range.to}\n    exact: "this"\n    prefix: ${JSON.stringify(resolution.selector.prefix)}\n    suffix: ${JSON.stringify(resolution.selector.suffix)}\n    blockLevel: false\n  author:\n    actorId: "ada"\n    displayName: "Ada"\n  at: "${resolution.at}"`));
    expect((await store.load(path))[0]).toMatchObject({ status: 'resolved', resolution: { at: resolution.at } });
    await store.setStatus(path, id, 'open');
    expect((await store.load(path))[0]?.status).toBe('open');
  });
});

it('merges concurrent resolve and delete from different branches without a Git conflict', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'markroot-comment-events-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.test', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.test' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const persist = async (workspace: MemoryWorkspace) => {
    for (const [file, content] of Object.entries(await files(workspace))) {
      await mkdir(dirname(join(directory, file)), { recursive: true });
      await writeFile(join(directory, file), content);
    }
  };
  const checkoutWorkspace = async () => new MemoryWorkspace(Object.fromEntries(await Promise.all(git('ls-files', '-z').split('\0').filter(Boolean).map(async (file) => [file, await readFile(join(directory, file), 'utf8')]))));
  try {
    const { workspace, id, revision } = await fixture();
    const kept = await new CommentStore(workspace).create(path, source, range, 'Kept thread', author, revision);
    git('init', '-b', 'main');
    await persist(workspace);
    git('add', '.'); git('commit', '-m', 'Initial');
    git('checkout', '-b', 'resolver');
    const resolver = await checkoutWorkspace();
    await new CommentStore(resolver).setStatus(path, id, 'resolved', { revision, selector: createSelector(source, range), author, at: '2026-09-07' });
    await new CommentStore(resolver).reattach(path, kept, source.replace('this', 'this very'), range, revision);
    await persist(resolver);
    git('add', '.'); git('commit', '-m', 'Resolve');
    git('checkout', 'main');
    const deleter = await checkoutWorkspace();
    await new CommentStore(deleter).delete(path, id);
    await new CommentStore(deleter).setStatus(path, kept, 'resolved', { revision, selector: createSelector(source, range), author, at: '2026-09-08' });
    await persist(deleter);
    git('add', '.'); git('commit', '-m', 'Delete');
    git('merge', 'resolver', '--no-edit');
    expect(git('status', '--porcelain')).toBe('');
    const merged = await new CommentStore(await checkoutWorkspace()).loadWithIssues(path);
    expect(merged.broken).toEqual([]);
    expect(merged.threads.map((thread) => thread.id)).toEqual([kept]);
  } finally { await rm(directory, { recursive: true, force: true }); }
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
