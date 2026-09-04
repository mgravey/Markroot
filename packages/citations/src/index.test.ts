import { describe, expect, it } from 'vitest';
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
