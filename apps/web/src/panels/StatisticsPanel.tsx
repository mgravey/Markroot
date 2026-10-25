import { memo } from 'react';
import type { DocumentStatistics, SectionStatistics, TextStatistics } from '@markroot/rendering';

interface Props {
  document: DocumentStatistics | undefined;
  selection: DocumentStatistics | undefined;
  includeCaptions: boolean;
  pending: boolean;
  onIncludeCaptionsChange(include: boolean): void;
  onNavigate(section: SectionStatistics): void;
}
const format = (value: number) => value.toLocaleString();

export const StatisticsPanel = memo(function StatisticsPanel({ document, selection, includeCaptions, pending, onIncludeCaptionsChange, onNavigate }: Props) {
  const largest = Math.max(1, ...document?.sections.map((section) => section.words) ?? []);
  return <div className="inspector-body statistics-panel" aria-busy={pending}>
    <label className="check"><input type="checkbox" checked={includeCaptions} onChange={(event) => onIncludeCaptionsChange(event.target.checked)}/><span>Include captions</span></label>
    {!document ? <p className="microcopy">{pending ? 'Counting document…' : 'Open a document to see its statistics.'}</p> : <>
      <div className="section-label"><span>Document</span></div>
      <TextCounts textOnly={document.textOnly} includingCitations={document.includingCitations}/>
      <dl className="statistics-counts">{([
        ['Paragraphs', document.paragraphs], ['Sentences (approx.)', document.sentences], ['Headings / sections', document.headings],
        ['Figures', document.figures], ['Tables', document.tables], ['Equations', document.equations], ['Citations', document.citations],
        ['Unique citation keys', document.uniqueCitationKeys.length], ['Cross-references', document.crossReferences], ['Footnotes', document.footnotes],
      ] as const).map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{format(count)}</dd></div>)}</dl>
      {selection && <section aria-label="Selection statistics"><div className="section-label"><span>Selection</span></div><TextCounts textOnly={selection.textOnly} includingCitations={selection.includingCitations}/></section>}
      {document.sections.length > 0 && <section aria-label="Words per top-level section"><div className="section-label"><span>Words by section · H1</span></div><table className="statistics-sections"><thead><tr><th scope="col">Section</th><th scope="col">Words</th></tr></thead><tbody>{document.sections.map((section) => <tr key={section.from}><td><button onClick={() => onNavigate(section)} title={`Go to ${section.label}`}><span>{section.label}</span><span className="statistics-bar" aria-hidden="true"><i style={{ width: `${section.words / largest * 100}%` }}/></span></button></td><td>{format(section.words)}</td></tr>)}</tbody></table><p className="microcopy">Text-only words, including each H1 and its subsections. Text before the first H1 is included in the document total.</p></section>}
    </>}
    <p className="microcopy statistics-note">Counts use prose and Unicode words; code blocks, metadata, raw HTML/LaTeX, bibliography and cross-reference tokens are excluded. Inline code counts once; math is counted as equations.</p>
  </div>;
});

function TextCounts({ textOnly, includingCitations }: { textOnly: TextStatistics; includingCitations: TextStatistics }) {
  return <dl className="statistics-counts">{([
    ['Words (text only)', textOnly.words], ['Words (incl. citations)', includingCitations.words],
    ['Characters (text only)', textOnly.characters], ['Characters (incl. citations)', includingCitations.characters],
    ['Without spaces (text only)', textOnly.charactersWithoutSpaces], ['Without spaces (incl. citations)', includingCitations.charactersWithoutSpaces],
  ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{format(value)}</dd></div>)}</dl>;
}
