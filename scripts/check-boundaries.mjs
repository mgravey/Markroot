import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('../', import.meta.url);
const roots = ['packages', 'apps'];
const manifests = new Map();

for (const group of roots) {
  for (const name of await readdir(new URL(`../${group}/`, import.meta.url))) {
    const directory = new URL(`../${group}/${name}/`, import.meta.url);
    try {
      const manifest = JSON.parse(await readFile(new URL('package.json', directory), 'utf8'));
      manifests.set(manifest.name, { directory, manifest });
    } catch { /* non-package directory */ }
  }
}

const graph = new Map();
const failures = [];
for (const [name, item] of manifests) {
  const declared = new Set(Object.keys({ ...item.manifest.dependencies, ...item.manifest.devDependencies }));
  const localImports = new Set();
  for (const file of await sourceFiles(new URL('src/', item.directory))) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\()['"](@markroot\/[^'"/]+)(\/[^'"]+)?['"]/g)) {
      const dependency = match[1];
      localImports.add(dependency);
      if (match[2]) failures.push(`${display(file)} imports private implementation ${dependency}${match[2]}`);
      if (!declared.has(dependency)) failures.push(`${display(file)} imports undeclared workspace dependency ${dependency}`);
    }
  }
  graph.set(name, localImports);
}

for (const name of graph.keys()) visit(name, [], new Set());
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log(`Dependency boundaries valid across ${manifests.size} workspace packages.`);

async function sourceFiles(directory) {
  const result = [];
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
      if (entry.isDirectory()) result.push(...await sourceFiles(child));
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) result.push(child);
    }
  } catch { /* package without source */ }
  return result;
}

function visit(name, path, active) {
  if (active.has(name)) {
    const cycle = [...path.slice(path.indexOf(name)), name].join(' -> ');
    if (!failures.includes(`Workspace dependency cycle: ${cycle}`)) failures.push(`Workspace dependency cycle: ${cycle}`);
    return;
  }
  const next = new Set(active); next.add(name);
  for (const dependency of graph.get(name) ?? []) if (graph.has(dependency)) visit(dependency, [...path, name], next);
}

function display(file) { return relative(new URL('..', root).pathname, file.pathname); }
