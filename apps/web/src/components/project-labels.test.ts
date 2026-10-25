import { describe, expect, it } from 'vitest';
import type { RecentProject } from '@markroot/settings';
import { projectLabels, projectParentHints } from './project-labels.js';

const project = (id: string, name: string): RecentProject => ({ id, name, lastOpenedAt: 1, handle: { name, resolve: async () => null } as unknown as FileSystemDirectoryHandle });

describe('project display labels', () => {
  it('disambiguates only shared names, with known parents or stable local identifiers', () => {
    const projects = [project('12345678-a', 'paper'), project('87654321-b', 'paper'), project('unique', 'notes')];
    expect(projectLabels(projects, new Map([['12345678-a', 'Research/drafts']])).map(({ hint }) => hint)).toEqual(['Research/drafts', 'Local folder · 87654321', undefined]);
  });

  it('derives parent hints only from an accessible remembered ancestor', async () => {
    const a = project('a', 'paper');
    const b = project('b', 'paper');
    const root = { ...project('root', 'Research'), handle: { name: 'Research', resolve: async (handle: FileSystemDirectoryHandle) => handle === a.handle ? ['drafts', 'paper'] : null } as unknown as FileSystemDirectoryHandle };
    const hints = await projectParentHints([a, b, root]);
    expect(hints.get('a')).toBe('Research/drafts');
    expect(hints.has('b')).toBe(false);
  });
});
