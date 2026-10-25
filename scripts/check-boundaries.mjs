import { readdir, readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export async function checkBoundaries(root = new URL('../', import.meta.url)) {
  const manifests = new Map();
  for (const group of ['packages', 'apps']) {
    for (const name of await readdir(new URL(`${group}/`, root))) {
      const directory = new URL(`${group}/${name}/`, root);
      try {
        const manifest = JSON.parse(await readFile(new URL('package.json', directory), 'utf8'));
        manifests.set(manifest.name, { directory, manifest });
      } catch { /* non-package directory */ }
    }
  }

  const graph = new Map();
  const failures = [];
  for (const [name, item] of manifests) {
    const declared = new Set(Object.keys({ ...item.manifest.dependencies, ...item.manifest.devDependencies, ...item.manifest.peerDependencies, ...item.manifest.optionalDependencies }));
    const localImports = new Set();
    for (const file of await sourceFiles(new URL('src/', item.directory))) {
      const source = ts.createSourceFile(file.pathname, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
      function inspect(node) {
        const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0]
          : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
        if (specifier && ts.isStringLiteralLike(specifier)) {
          const match = /^(@markroot\/[^/]+)(\/.*)?$/.exec(specifier.text);
          if (match) {
            const dependency = match[1];
            localImports.add(dependency);
            const display = relative(fileURLToPath(root), fileURLToPath(file));
            if (match[2]) failures.push(`${display} imports private implementation ${specifier.text}`);
            if (!declared.has(dependency)) failures.push(`${display} imports undeclared workspace dependency ${dependency}`);
          }
        }
        ts.forEachChild(node, inspect);
      }
      inspect(source);
    }
    for (const dependency of declared) if (dependency.startsWith('@markroot/') && !localImports.has(dependency)) failures.push(`${name} declares unused workspace dependency ${dependency}`);
    graph.set(name, localImports);
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
  for (const name of graph.keys()) visit(name, [], new Set());
  return { failures, count: manifests.size };
}

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { failures, count } = await checkBoundaries();
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else console.log(`Dependency boundaries valid across ${count} workspace packages.`);
}
