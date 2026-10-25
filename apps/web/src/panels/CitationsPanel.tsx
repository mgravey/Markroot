import { memo } from 'react';
import { Search } from 'lucide-react';
import type { CitationRecord } from '@markroot/citations';

export const CitationsPanel = memo(function CitationsPanel({ records, query, setQuery }: { records: readonly CitationRecord[]; query: string; setQuery(value: string): void }) {
  const filtered = records.filter((record) => [record.key, record.title, record.author].some((value) => value?.toLowerCase().includes(query.toLowerCase())));
  return <div className="inspector-body"><label className="search-field"><Search size={14}/><input aria-label="Search citations" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search local .bib files"/></label><div className="citation-list">{filtered.map((record) => <article key={`${record.source}:${record.key}`}><code>@{record.key}</code><strong>{record.title ?? 'Untitled reference'}</strong><span>{[record.author, record.year].filter(Boolean).join(' · ')}</span></article>)}</div>{!records.length && <p className="microcopy">No BibTeX entries found in this folder.</p>}</div>;
});
