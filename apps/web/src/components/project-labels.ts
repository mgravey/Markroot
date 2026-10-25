import type { RecentProject } from '@markroot/settings';

/** Handles expose no absolute parent path; use a known ancestor when possible, otherwise stable identity. */
export function projectLabels(projects: readonly RecentProject[], parents: ReadonlyMap<string, string> = new Map()) {
  const counts = new Map<string, number>();
  for (const project of projects) counts.set(project.name, (counts.get(project.name) ?? 0) + 1);
  return projects.map((project) => ({ project, hint: (counts.get(project.name) ?? 0) > 1 ? parents.get(project.id) ?? `Local folder · ${project.id.slice(0, 8)}` : undefined }));
}

export async function projectParentHints(projects: readonly RecentProject[]): Promise<ReadonlyMap<string, string>> {
  const hints = new Map<string, string>();
  for (const { project, hint } of projectLabels(projects)) {
    if (!hint) continue;
    for (const ancestor of projects) {
      if (ancestor.id === project.id) continue;
      const path = await ancestor.handle.resolve(project.handle).catch(() => null);
      if (path?.length) { hints.set(project.id, [ancestor.handle.name, ...path.slice(0, -1)].join('/')); break; }
    }
  }
  return hints;
}
