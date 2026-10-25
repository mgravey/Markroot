import { describe, expect, it, vi } from 'vitest';
import { workspacePath } from '@markroot/core';
import { DocumentSession } from '@markroot/document';
import { MemoryWorkspace } from '@markroot/workspace';
import { collectPreviewResources, IMAGE_REFERENCE, PreviewResourceCache } from './document-resources.js';

const snapshot = (source: string) => new DocumentSession(workspacePath('docs/a.md'), source).snapshot();

describe('preview resources', () => {
  it('matches wrapped and titled image references', () => {
    const refs = [...'![a](x.png) ![b [c]](<my img.png> "t")'.matchAll(IMAGE_REFERENCE)].map((match) => match[1]);
    expect(refs).toEqual(['x.png', '<my img.png>']);
  });

  it('reuses blobs across renders until the file version changes, and drops unused entries', async () => {
    const workspace = new MemoryWorkspace({ 'docs/x.png': 'one', 'docs/y.png': 'two' });
    const read = vi.spyOn(workspace, 'readBytes');
    const cache = new PreviewResourceCache();
    const first = await collectPreviewResources(workspace, snapshot('![x](x.png) ![y](y.png)'), cache);
    const second = await collectPreviewResources(workspace, snapshot('![x](x.png) ![y](y.png) edit'), cache);
    expect(read).toHaveBeenCalledTimes(2);
    expect(second[0]!.content).toBe(first[0]!.content);
    await workspace.writeFile(workspacePath('docs/x.png'), 'changed');
    const third = await collectPreviewResources(workspace, snapshot('![x](x.png)'), cache);
    expect(read).toHaveBeenCalledTimes(3);
    expect(await (third[0]!.content as Blob).text()).toBe('changed');
    expect(cache.size).toBe(1);
  });

  it('rethrows when the render is cancelled instead of swallowing the abort', async () => {
    const workspace = new MemoryWorkspace({ 'docs/x.png': 'one' });
    const controller = new AbortController();
    vi.spyOn(workspace, 'stat').mockImplementation(async () => { controller.abort(); throw new Error('stat failed'); });
    await expect(collectPreviewResources(workspace, snapshot('![x](x.png)'), new PreviewResourceCache(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('skips missing files without failing the preview', async () => {
    const resources = await collectPreviewResources(new MemoryWorkspace(), snapshot('![x](missing.png) ![r](https://x/y.png)'), new PreviewResourceCache());
    expect(resources).toEqual([]);
  });
});
