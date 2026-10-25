import { expect, it } from 'vitest';
import { workspacePath } from '@markroot/core';
import { normalizeDoi, parseBibTeX } from './index.js';

it('indexes BibTeX metadata', () => {
  const records = parseBibTeX('@article{doe2026, title={A {Useful} Paper}, author={Doe, Jane}, year={2026}}', workspacePath('refs.bib'));
  expect(records[0]).toMatchObject({ key: 'doe2026', type: 'article', author: 'Doe, Jane', year: '2026' });
});

it('derives years from bare year and date fields', () => {
  const records = parseBibTeX(`
@book{bare, title = {Bare year}, year = 2024}
@online{dated, title = {Dated item}, date = {2025-03-18}}
`, workspacePath('refs.bib'));
  expect(records.map(({ key, year }) => ({ key, year }))).toEqual([
    { key: 'bare', year: '2024' },
    { key: 'dated', year: '2025' },
  ]);
});

it('normalizes safe DOI identifiers', () => {
  const [record] = parseBibTeX('@article{doi-item, title={DOI item}, doi={https://doi.org/10.1234/example.7}}', workspacePath('refs.bib'));
  expect(record?.doi).toBe('10.1234/example.7');
  expect(normalizeDoi('doi:10.5555/ABC-123')).toBe('10.5555/ABC-123');
  expect(normalizeDoi('javascript:alert(1)')).toBeUndefined();
});

it('honors quotes only at the top level and keeps later entries intact', () => {
  const records = parseBibTeX(`
@misc{disk, title = {A 5" floppy}, year = 1990}
@article{after, title = "Quoted {"} title", author = {Roe, R.}, year = {2001}}
@book(paren, title = {Paren entry}, year = 2002)
`, workspacePath('refs.bib'));
  expect(records.map(({ key, title }) => ({ key, title }))).toEqual([
    { key: 'disk', title: 'A 5" floppy' },
    { key: 'after', title: 'Quoted " title' },
    { key: 'paren', title: 'Paren entry' },
  ]);
});

it('skips comments and preambles and expands @string macros with # concatenation', () => {
  const records = parseBibTeX(`
@comment{ignored, title = {Not an entry}}
@preamble{"\\newcommand{\\x}{y}"}
@string{ jnl = "Journal of Tests" }
@article{macro, title = jnl # ", " # {Vol. 1}, month = mar, year = 2020}
`, workspacePath('refs.bib'));
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ key: 'macro', title: 'Journal of Tests, Vol. 1' });
});

it('decodes LaTeX accents and keeps brace-protected corporate authors whole', () => {
  const [record] = parseBibTeX(String.raw`@article{latex, title = {{\"U}ber Caf\'e na\"{\i}ve Se\~nor \c{c}a Stra\ss e {DNA} \`a l'h\^otel \textit{Homo} \& Co}, author = {{World Health Organization} and M{\"u}ller, J{\"o}rg and Ana Garc\'{\i}a}, year = 2021}`, workspacePath('refs.bib'));
  expect(record?.title).toBe("Über Café naïve Señor ça Straße DNA à l'hôtel Homo & Co");
  expect(record?.author).toBe('World Health Organization and Müller, Jörg and Ana García');
  expect(record?.authors).toEqual([{ literal: 'World Health Organization' }, { family: 'Müller', given: 'Jörg' }, { family: 'García', given: 'Ana' }]);
});
