import { diffLines } from 'diff';

export type EditorLineChangeKind = 'added' | 'modified' | 'deleted';

export interface EditorLineChange {
  readonly line: number;
  readonly kind: EditorLineChangeKind;
}

export function editorLineChanges(base: string | undefined, current: string): readonly EditorLineChange[] {
  if (base === undefined || base === current) return [];
  const result = new Map<number, EditorLineChangeKind>();
  const parts = diffLines(base, current);
  const currentLineCount = current.split('\n').length;
  let currentLine = 1;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part.removed) {
      const following = parts[index + 1];
      const removedLines = diffLinesIn(part.value);
      const removedCount = removedLines.length;
      if (following?.added) {
        const addedLines = diffLinesIn(following.value);
        const addedCount = addedLines.length;
        const modifiedCount = Math.min(removedCount, addedCount);
        for (let offset = 0; offset < addedCount; offset += 1) {
          if (offset >= modifiedCount) mark(result, currentLine + offset, 'added');
          else if (removedLines[offset] !== addedLines[offset]) mark(result, currentLine + offset, 'modified');
        }
        if (removedCount > addedCount) mark(result, deletionAnchor(currentLine, addedCount, currentLineCount), 'deleted');
        currentLine += addedCount;
        index += 1;
      } else {
        mark(result, deletionAnchor(currentLine, 0, currentLineCount), 'deleted');
      }
      continue;
    }

    const count = diffLineCount(part.value);
    if (part.added) for (let offset = 0; offset < count; offset += 1) mark(result, currentLine + offset, 'added');
    currentLine += count;
  }

  return [...result].sort(([left], [right]) => left - right).map(([line, kind]) => ({ line, kind }));
}

function diffLineCount(value: string): number {
  return diffLinesIn(value).length;
}

function diffLinesIn(value: string): readonly string[] {
  if (!value) return [];
  const lines = value.split('\n');
  if (value.endsWith('\n')) lines.pop();
  return lines;
}

function deletionAnchor(currentLine: number, addedCount: number, currentLineCount: number): number {
  return Math.max(1, Math.min(currentLineCount, currentLine + Math.max(0, addedCount - 1)));
}

function mark(changes: Map<number, EditorLineChangeKind>, line: number, kind: EditorLineChangeKind) {
  const current = changes.get(line);
  const priority: Record<EditorLineChangeKind, number> = { added: 1, deleted: 2, modified: 3 };
  if (!current || priority[kind] > priority[current]) changes.set(line, kind);
}
