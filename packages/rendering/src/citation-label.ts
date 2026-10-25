import { decodeLatex } from '@markroot/citations';
import type { RenderCitation } from './index.js';

/** Plain text shared by the rendered preview and statistics; no HTML entities or markup. */
export function citationTextLabel(citation: RenderCitation | undefined, key: string, textual: boolean): string {
  if (!citation) return key;
  const display = (value: string) => /[{}\\]/.test(value) ? decodeLatex(value) : value;
  const surname = (entry: string) => entry.includes(',') ? entry.split(',')[0]!.trim() : entry.split(/\s+/).at(-1)!;
  const names = citation.authors?.length
    ? citation.authors.map((name) => display('literal' in name ? name.literal : name.family))
    : display(citation.author ?? '').split(/\s+and\s+/i).map((entry) => entry.trim()).filter(Boolean).map(surname);
  const author = (names.length > 2 ? `${names[0]} et al.` : names.join(' & ')) || key;
  const year = citation.year || 'n.d.';
  return textual ? `${author} (${year})` : `${author}, ${year}`;
}
