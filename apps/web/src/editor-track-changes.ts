import { diffWordsWithSpace } from 'diff';

export type EditorTrackChange =
  | { readonly kind: 'insert'; readonly from: number; readonly to: number }
  | { readonly kind: 'delete'; readonly at: number; readonly value: string };

export function editorTrackChanges(base: string | undefined, current: string): readonly EditorTrackChange[] {
  if (base === undefined || base === current) return [];
  const changes: EditorTrackChange[] = [];
  let position = 0;
  for (const part of diffWordsWithSpace(base, current)) {
    if (part.added) {
      changes.push({ kind: 'insert', from: position, to: position + part.value.length });
      position += part.value.length;
    } else if (part.removed) {
      changes.push({ kind: 'delete', at: position, value: part.value });
    } else {
      position += part.value.length;
    }
  }
  return changes;
}
