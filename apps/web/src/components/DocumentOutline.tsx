import { FileImage, Heading, Table2, X } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { DocumentOutlineItem } from '@markroot/rendering';

interface Props {
  items: readonly DocumentOutlineItem[];
  activeBlock?: string | undefined;
  maxLevel: 2 | 3 | 6;
  showFigures: boolean;
  onSelect(item: DocumentOutlineItem): void;
  onMaxLevelChange(level: 2 | 3 | 6): void;
  onShowFiguresChange(show: boolean): void;
  onClose(): void;
}

export function DocumentOutline({ items, activeBlock, maxLevel, showFigures, onSelect, onMaxLevelChange, onShowFiguresChange, onClose }: Props) {
  const visibleItems = filterOutlineItems(items, maxLevel, showFigures);
  return <div className="outline-overlay">
    <header>
      <div className="outline-title"><strong>Document outline</strong><button onClick={onClose} title="Close outline" aria-label="Close document outline"><X size={14}/></button></div>
      <div className="outline-filters">
        <label><span>Depth</span><select aria-label="Outline heading depth" value={maxLevel} onChange={(event) => onMaxLevelChange(Number(event.target.value) as 2 | 3 | 6)}><option value="2">2 levels</option><option value="3">3 levels</option><option value="6">All levels</option></select></label>
        <button className={showFigures ? 'selected' : ''} aria-pressed={showFigures} onClick={() => onShowFiguresChange(!showFigures)} title="Show figures in outline"><FileImage size={13}/><span>Figures</span></button>
      </div>
    </header>
    <nav aria-label="Document outline">
      {visibleItems.length > 0 ? <ul>{visibleItems.map((item) => {
        const Icon = item.kind === 'figure' ? FileImage : item.kind === 'table' ? Table2 : Heading;
        const depth = item.kind === 'section' ? Math.max(0, (item.level ?? 1) - 1) : 1;
        return <li key={`${item.kind}:${item.id}`} style={{ '--outline-depth': depth } as CSSProperties}>
          <button className={activeBlock === item.blockId ? 'active' : ''} onClick={() => onSelect(item)} title={`${item.kind}: ${item.label}`}>
            <Icon size={13}/><span className="outline-number">{item.number ?? '·'}</span><span className="outline-entry-label">{item.label}</span>
          </button>
        </li>;
      })}</ul> : <p>No entries match the current outline options.</p>}
    </nav>
  </div>;
}

export function filterOutlineItems(items: readonly DocumentOutlineItem[], maxLevel: 2 | 3 | 6, showFigures: boolean): readonly DocumentOutlineItem[] {
  return items.filter((item) => {
    if (item.kind === 'figure') return showFigures;
    if (item.kind === 'section') return (item.level ?? 1) <= maxLevel;
    return true;
  });
}
