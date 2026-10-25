import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { checkBoundaries } from './check-boundaries.mjs';

async function fixture(t, source, dependencies = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'markroot-boundaries-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'apps'));
  await mkdir(join(directory, 'packages/example/src'), { recursive: true });
  await writeFile(join(directory, 'packages/example/package.json'), JSON.stringify({ name: '@markroot/example', dependencies }));
  await writeFile(join(directory, 'packages/example/src/index.ts'), source);
  return pathToFileURL(`${directory}/`);
}

for (const source of [
  "import '@markroot/core';",
  "import { value } from '@markroot/core';",
  "import type { Value } from '@markroot/core';",
  "import { type Value } from '@markroot/core';",
  "export { value } from '@markroot/core';",
  "export type { Value } from '@markroot/core';",
  "export * from '@markroot/core';",
  "const load = () => import('@markroot/core');",
  "type Value = import('@markroot/core').Value;",
]) {
  test(`checks dependency declarations for ${source}`, async (t) => {
    const root = await fixture(t, source);
    assert.deepEqual((await checkBoundaries(root)).failures, ['packages/example/src/index.ts imports undeclared workspace dependency @markroot/core']);
    await writeFile(new URL('packages/example/package.json', root), JSON.stringify({ name: '@markroot/example', dependencies: { '@markroot/core': 'workspace:*' } }));
    assert.deepEqual((await checkBoundaries(root)).failures, []);
  });
}

test('rejects private imports and re-exports, including side-effect and type imports', async (t) => {
  const root = await fixture(t, "import '@markroot/core/init'; export type { Value } from '@markroot/core/types';", { '@markroot/core': 'workspace:*' });
  assert.deepEqual((await checkBoundaries(root)).failures, [
    'packages/example/src/index.ts imports private implementation @markroot/core/init',
    'packages/example/src/index.ts imports private implementation @markroot/core/types',
  ]);
});

test('reports unused declarations without counting comments or strings as imports', async (t) => {
  const root = await fixture(t, `// import '@markroot/core';
/* export * from '@markroot/core'; */
const text = "import('@markroot/core')";`, { '@markroot/core': 'workspace:*', external: '*' });
  assert.deepEqual((await checkBoundaries(root)).failures, ['@markroot/example declares unused workspace dependency @markroot/core']);
});

test('counts imports in nested sources and declarations in every dependency section', async (t) => {
  const root = await fixture(t, '');
  await mkdir(new URL('packages/example/src/nested/', root));
  await writeFile(new URL('packages/example/src/nested/types.d.ts', root), "export type { Value } from '@markroot/core';");
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    await writeFile(new URL('packages/example/package.json', root), JSON.stringify({ name: '@markroot/example', [section]: { '@markroot/core': 'workspace:*', '@markroot/unused': 'workspace:*' } }));
    assert.deepEqual((await checkBoundaries(root)).failures, ['@markroot/example declares unused workspace dependency @markroot/unused']);
  }
});

test('includes side-effect imports and re-exports in cycle detection', async (t) => {
  const root = await fixture(t, "import '@markroot/core';", { '@markroot/core': 'workspace:*' });
  await mkdir(new URL('packages/core/src/', root), { recursive: true });
  await writeFile(new URL('packages/core/package.json', root), JSON.stringify({ name: '@markroot/core', dependencies: { '@markroot/example': 'workspace:*' } }));
  await writeFile(new URL('packages/core/src/index.ts', root), "export * from '@markroot/example';");
  assert.ok((await checkBoundaries(root)).failures.some((failure) => failure.startsWith('Workspace dependency cycle:')));
});
