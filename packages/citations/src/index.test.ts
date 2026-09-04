import { describe, expect, it } from 'vitest';
import { workspacePath } from '@markroot/core';
import { parseBibTeX } from './index.js';

it('indexes BibTeX metadata', () => {
  const records = parseBibTeX('@article{doe2026, title={A {Useful} Paper}, author={Doe, Jane}, year={2026}}', workspacePath('refs.bib'));
  expect(records[0]).toMatchObject({ key: 'doe2026', type: 'article', author: 'Doe, Jane', year: '2026' });
});
