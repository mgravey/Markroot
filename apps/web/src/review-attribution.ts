import { diffLines } from 'diff';
import type { AuthorIdentity, SourceRange } from '@markroot/core';

/** The slice of a review draft needed to attribute changes; small enough to post to a worker. */
export interface AttributionInput {
  readonly base: string;
  readonly compare: string;
  readonly changes: readonly { readonly id: string; readonly baseText: string; readonly compareText: string; readonly baseRange: SourceRange; readonly compareRange: SourceRange }[];
}
/** One historical file version, oldest first. */
export interface AttributionVersion { readonly author: AuthorIdentity; readonly content: string }

/** Attributes each change to the last commit whose line diff added (or removed) its probe text. */
export function attributeChanges(input: AttributionInput, versions: readonly AttributionVersion[]): ReadonlyMap<string, readonly AuthorIdentity[]> {
  const result = new Map<string, readonly AuthorIdentity[]>();
  const probes = input.changes.map((change) => ({
    id: change.id,
    added: change.compareText ? attributionProbe(input.compare, change.compareRange.from, change.compareText) : '',
    removed: change.baseText ? attributionProbe(input.base, change.baseRange.from, change.baseText) : '',
  }));
  let previous = '';
  for (const version of versions) {
    const parts = diffLines(previous, version.content);
    const added = parts.filter((part) => part.added).map((part) => part.value).join('\n');
    const removed = parts.filter((part) => part.removed).map((part) => part.value).join('\n');
    for (const probe of probes) {
      if (changeTextAppearsIn(probe.added, added) || changeTextAppearsIn(probe.removed, removed)) result.set(probe.id, [version.author]);
    }
    previous = version.content;
  }
  return result;
}

export function attributionProbe(source: string, offset: number, fallback: string): string {
  const start = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const endIndex = source.indexOf('\n', offset);
  const end = endIndex < 0 ? source.length : endIndex;
  const line = source.slice(start, end).trim();
  if (!line) return fallback.trim();
  if (line.length <= 240) return line;
  const center = Math.max(0, Math.min(line.length, offset - start));
  return line.slice(Math.max(0, center - 120), Math.min(line.length, center + 120));
}

function changeTextAppearsIn(changeText: string, changedLines: string): boolean {
  const value = changeText.trim();
  return Boolean(value) && changedLines.includes(value);
}
