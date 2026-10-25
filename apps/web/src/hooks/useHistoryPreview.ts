import { useMemo, useState } from 'react';
import { mapDocumentBlocks, type DocumentSnapshot } from '@markroot/document';
import type { UndoTree } from '@markroot/history';

export function useHistoryPreview(tree: UndoTree | undefined, snapshot: DocumentSnapshot | undefined) {
  const [selection, setSelection] = useState<{ tree: UndoTree; id: string; compareId?: string }>();
  const selected = selection?.tree === tree ? selection : undefined;
  const node = selected && tree?.allNodes.find((node) => node.id === selected.id);
  const text = node && tree?.textAt(node.id);
  const base = selected?.compareId && tree ? tree.textAt(selected.compareId) : snapshot?.source;
  const active = text !== undefined;
  const preview = useMemo(() => active && snapshot ? { ...snapshot, source: text, blocks: mapDocumentBlocks(text) } : undefined, [active, snapshot, text]);
  return {
    active, snapshot: preview, base, selectedId: node?.id, compareId: selected?.compareId,
    select: (id: string) => { if (tree) setSelection({ tree, id }); },
    compare: (id: string) => { if (tree && selected) setSelection({ ...selected, compareId: id }); },
    close: () => setSelection(undefined),
  };
}
