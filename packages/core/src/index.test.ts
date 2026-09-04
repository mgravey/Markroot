import { describe, expect, it } from 'vitest';
import { MarkrootError, relativeWorkspaceReference, resolveWorkspaceReference, workspacePath } from './index.js';

describe('workspace references', () => {
  it('resolves dot segments and encoded names relative to the current document', () => {
    expect(resolveWorkspaceReference(workspacePath('chapters/methods/paper.qmd'), '../../figures/my%20plot.png')).toBe('figures/my plot.png');
    expect(resolveWorkspaceReference(workspacePath('chapters/paper.qmd'), '/figures/plot.png')).toBe('figures/plot.png');
  });

  it('creates portable relative references', () => {
    expect(relativeWorkspaceReference(workspacePath('chapters/methods/paper.qmd'), workspacePath('figures/my plot.png'))).toBe('../../figures/my plot.png');
    expect(relativeWorkspaceReference(workspacePath('paper.qmd'), workspacePath('figures/plot.png'))).toBe('figures/plot.png');
  });

  it('rejects references that escape the workspace', () => {
    expect(() => resolveWorkspaceReference(workspacePath('paper.qmd'), '../secret.png')).toThrow(MarkrootError);
  });
});
