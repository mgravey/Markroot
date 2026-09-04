import { FileImage, Heading, Table2, X } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { DocumentOutlineItem } from '@markroot/rendering';

interface Props {
  items: readonly DocumentOutlineItem[];
  onSelect(item: DocumentOutlineItem): void;
  onClose(): void;
}

export function DocumentOutline({ items, onSelect, onClose }: Props) {
  return <div className="outline-overlay">
    <header><strong>Document outline</strong><button onClick={onClose} title="Close outline" aria-label="Close document outline"><X size={14}/></button></header>
    <nav aria-label="Document outline">
      {items.length > 0 ? <ul>{items.map((item) => {
        const Icon = item.kind === 'figure' ? FileImage : item.kind === 'table' ? Table2 : Heading;
        const depth = item.kind === 'section' ? Math.max(0, (item.level ?? 1) - 1) : 1;
        return <li key={`${item.kind}:${item.id}`} style={{ '--outline-depth': depth } as CSSProperties}>
          <button onClick={() => onSelect(item)} title={`${item.kind}: ${item.label}`}>
            <Icon size={13}/><span className="outline-number">{item.number ?? '·'}</span><span>{item.label}</span>
          </button>
        </li>;
      })}</ul> : <p>No sections, figures, or tables yet.</p>}
    </nav>
  </div>;
}
