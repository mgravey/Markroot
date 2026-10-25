import type { ProgressEvent } from '@markroot/core';
import type { ExportFormat } from '@markroot/export';

export interface ExportProgressState extends ProgressEvent { readonly format: ExportFormat }
export type ExportDestination = 'download' | 'save-as' | 'workspace';

export function exportStepTotal(format: ExportFormat): number { return format === 'pdf' ? 4 : 3; }

export function appExportProgress(format: ExportFormat, progress: ProgressEvent): ExportProgressState {
  const total = exportStepTotal(format);
  const completed = progress.phase === 'complete' ? total - 1 : progress.phase === 'typst' ? 2 : progress.phase === 'pandoc' || progress.phase === 'prepare' ? 1 : 0;
  return { format, phase: progress.phase, completed, total, ...(progress.message ? { message: progress.message } : {}) };
}

export function exportSaveMessage(destination: ExportDestination): string {
  return destination === 'workspace' ? 'Saving beside the source' : destination === 'save-as' ? 'Writing selected file' : 'Preparing browser download';
}
