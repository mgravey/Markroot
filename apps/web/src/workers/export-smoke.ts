import type { ExportFormat } from '@markroot/export';
import { WorkerExporter } from './export-client.js';

const output = document.querySelector<HTMLElement>('#result');
if (!output) throw new Error('Smoke test output is missing.');

const source = `---
title: Export smoke test
---

# Browser-only export

This document contains **formatted text**, a short list, and inline math $x^2$.

- HTML
- DOCX
- PDF
`;

const exporter = new WorkerExporter();
const reports: string[] = [];

try {
  for (const format of ['html', 'docx', 'pdf'] satisfies readonly ExportFormat[]) {
    output.textContent = [...reports, `${format.toUpperCase()}: running…`].join('\n');
    const result = await exporter.export(
      { format, source, filename: 'chapters/export-smoke.qmd' },
      { onProgress: (progress) => {
        output.textContent = [...reports, `${format.toUpperCase()}: ${progress.message ?? progress.phase}`].join('\n');
      } },
    );
    if (result.blob.size === 0) throw new Error(`${format.toUpperCase()} export was empty.`);
    reports.push(`${format.toUpperCase()}: ${result.blob.size} bytes, ${result.warnings.length} warning(s)`);
  }
  output.dataset.status = 'passed';
  output.textContent = ['PASS', ...reports].join('\n');
} catch (error) {
  output.dataset.status = 'failed';
  output.textContent = `FAIL\n${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n${reports.join('\n')}`;
} finally {
  exporter.terminate();
}
