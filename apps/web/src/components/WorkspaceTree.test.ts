import { describe, expect, it } from 'vitest';
import { workspacePath } from '@markroot/core';
import type { WorkspaceEntry } from '@markroot/workspace';
import { buildTree } from './WorkspaceTree.js';

describe('workspace tree', () => {
  it('marks Markdown documents and every containing folder', () => {
    const entries: readonly WorkspaceEntry[] = [
      directory('assets'),
      file('assets/figure.png'),
      directory('notes'),
      directory('notes/drafts'),
      file('notes/drafts/paper.qmd'),
      file('README.md'),
      file('references.bib'),
    ];

    const tree = buildTree(entries);
    const assets = tree.find((node) => node.path === 'assets');
    const notes = tree.find((node) => node.path === 'notes');
    const readme = tree.find((node) => node.path === 'README.md');
    const bibliography = tree.find((node) => node.path === 'references.bib');

    expect(assets?.containsMarkdown).toBe(false);
    expect(notes?.containsMarkdown).toBe(true);
    expect(notes?.children[0]?.containsMarkdown).toBe(true);
    expect(notes?.children[0]?.children[0]?.containsMarkdown).toBe(true);
    expect(readme?.containsMarkdown).toBe(true);
    expect(bibliography?.containsMarkdown).toBe(false);
  });

  it('keeps directories before files while preserving alphabetical order', () => {
    const tree = buildTree([
      file('z.qmd'),
      directory('beta'),
      file('a.md'),
      directory('alpha'),
    ]);

    expect(tree.map((node) => node.path)).toEqual(['alpha', 'beta', 'a.md', 'z.qmd']);
  });
});

function file(path: string): WorkspaceEntry { return { kind: 'file', path: workspacePath(path) }; }
function directory(path: string): WorkspaceEntry { return { kind: 'directory', path: workspacePath(path) }; }
