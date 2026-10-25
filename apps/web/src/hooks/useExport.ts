import { useCallback, useEffect, useRef, useState } from 'react';
import { workspacePath } from '@markroot/core';
import type { DocumentSnapshot } from '@markroot/document';
import type { ExportFormat } from '@markroot/export';
import type { GuardedWorkspace } from '@markroot/workspace';
import { collectDocumentResources } from '../document-resources.js';
import type { WorkerExporter } from '../workers/export-client.js';
import { appExportProgress, exportSaveMessage, exportStepTotal, type ExportDestination, type ExportProgressState } from '../export-progress.js';
import { useEvent } from './useEvent.js';

interface Options {
  readonly snapshot: DocumentSnapshot | undefined;
  readonly workspace: GuardedWorkspace | undefined;
  readonly justified: boolean;
  readonly setNotice: (notice: string | undefined) => void;
  /** Called after a file was written beside the source; failures are reported by the caller. */
  readonly onWorkspaceChanged: () => void;
}

export function useExport({ snapshot, workspace, justified, setNotice, onWorkspaceChanged }: Options) {
  const exporterRef = useRef<WorkerExporter | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ExportProgressState>();
  const controllerRef = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => { controllerRef.current?.abort(); exporterRef.current?.terminate(); }, []);

  const exportDocument = useEvent(async (format: ExportFormat, destination: ExportDestination) => {
    if (!snapshot || busy) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setProgress({ format, phase: 'resources', completed: 0, total: exportStepTotal(format), message: 'Starting local export' });
    try {
      let saveHandle: FileSystemFileHandle | undefined;
      if (destination === 'save-as' && 'showSaveFilePicker' in window) {
        saveHandle = await (window as Window & { showSaveFilePicker(options: SaveFilePickerOptions): Promise<FileSystemFileHandle> }).showSaveFilePicker({
          suggestedName: `${fileBasename(snapshot.path)}.${format}`,
          types: [{ description: `${format.toUpperCase()} document`, accept: { [exportMime(format)]: [`.${format}`] } }],
        });
      }
      setNotice(`Preparing ${format.toUpperCase()} locally…`);
      setProgress({ format, phase: 'resources', completed: 0, total: exportStepTotal(format), message: 'Collecting document resources' });
      const [{ parseExportOptions }, { WorkerExporter }] = await Promise.all([import('@markroot/export'), import('../workers/export-client.js')]);
      controller.signal.throwIfAborted();
      const exporter = exporterRef.current ??= new WorkerExporter();
      const exportOptions = parseExportOptions(snapshot.source);
      const resources = workspace ? await collectDocumentResources(workspace, snapshot, format, exportOptions, {
        signal: controller.signal,
        onProgress: (update) => setProgress(appExportProgress(format, update)),
      }) : [];
      const result = await exporter.export(
        { format, source: snapshot.source, filename: snapshot.path, resources, justified, ...exportOptions },
        { signal: controller.signal, onProgress: (update) => {
          setNotice(update.message ?? `Exporting ${format.toUpperCase()}…`);
          setProgress(appExportProgress(format, update));
        } },
      );
      const total = exportStepTotal(format);
      setProgress({ format, phase: 'save', completed: total - 1, total, message: exportSaveMessage(destination) });
      let wroteToWorkspace = false;
      if (saveHandle) {
        const writable = await saveHandle.createWritable();
        await writable.write(result.blob);
        await writable.close();
      } else if (destination === 'workspace' && workspace) {
        const parent = snapshot.path.includes('/') ? snapshot.path.slice(0, snapshot.path.lastIndexOf('/') + 1) : '';
        const outputPath = workspacePath(`${parent}${result.filename}`);
        await workspace.writeBytes(outputPath, new Uint8Array(await result.blob.arrayBuffer()));
        wroteToWorkspace = true;
      } else download(result.blob, result.filename);
      setProgress({ format, phase: 'complete', completed: total, total, message: `${result.filename} is ready` });
      setNotice(`${result.filename} is ready${destination === 'workspace' ? ' beside the source' : ''}.`);
      if (wroteToWorkspace) onWorkspaceChanged();
    } catch (error) { setProgress(undefined); setNotice(error instanceof DOMException && error.name === 'AbortError' ? 'Export cancelled.' : error instanceof Error ? error.message : String(error)); }
    finally { if (controllerRef.current === controller) controllerRef.current = undefined; setBusy(false); }
  });
  const cancel = useCallback(() => controllerRef.current?.abort(), []);

  return { busy, progress, exportDocument, cancel };
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: readonly { description: string; accept: Record<string, readonly string[]> }[];
}

function download(blob: Blob, filename: string): void { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
function fileBasename(path: string): string { return (path.split('/').at(-1) ?? 'document').replace(/\.(?:md|qmd)$/i, ''); }
function exportMime(format: ExportFormat): string { return format === 'html' ? 'text/html' : format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf'; }
