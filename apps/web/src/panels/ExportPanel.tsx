import { memo, useState } from 'react';
import { Check, Download, RefreshCw, X } from 'lucide-react';
import type { ExportFormat } from '@markroot/export';

import type { ExportDestination, ExportProgressState } from '../export-progress.js';

export const ExportPanel = memo(function ExportPanel({ disabled, busy, progress, onCancel, onExport }: { disabled: boolean; busy: boolean; progress: ExportProgressState | undefined; onCancel(): void; onExport(format: ExportFormat, destination: ExportDestination): Promise<void> }) {
  const [destination, setDestination] = useState<ExportDestination>('download');
  return <div className="inspector-body"><p>Exports run locally with bundled engines and local document resources. Comments and review markers are removed.</p><label className="field"><span>Destination</span><select disabled={busy} value={destination} onChange={(event) => setDestination(event.target.value as ExportDestination)}><option value="download">Browser download</option><option value="save-as">Save As…</option><option value="workspace">Beside source</option></select></label>{(['html', 'docx', 'pdf'] as const).map((format) => <button key={format} className="export-button" disabled={disabled || busy} onClick={() => void onExport(format, destination)}><Download size={16}/><span><strong>{format.toUpperCase()}</strong><small>{format === 'pdf' ? 'Pandoc → Typst WASM' : 'Pandoc WASM'}</small></span></button>)}{progress && <ExportProgress progress={progress} busy={busy} onCancel={onCancel}/>}</div>;
});

function ExportProgress({ progress, busy, onCancel }: { progress: ExportProgressState; busy: boolean; onCancel(): void }) {
  const total = progress.total ?? 1;
  const percent = Math.round(Math.max(0, Math.min(1, progress.completed / total)) * 100);
  const steps = progress.format === 'pdf' ? ['Resources', 'Pandoc', 'Typst', 'Save'] : ['Resources', 'Pandoc', 'Save'];
  return <section className={`export-progress ${busy ? 'running' : 'complete'}`} aria-live="polite">
    <div className="export-progress-heading">{busy ? <RefreshCw className="spin" size={15}/> : <Check size={15}/>}<strong>{progress.format.toUpperCase()} export</strong><span>{percent}%</span></div>
    <div className="export-progress-track" role="progressbar" aria-label={`${progress.format.toUpperCase()} export progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }}/></div>
    <p>{progress.message ?? `Exporting ${progress.format.toUpperCase()}…`}</p>
    <ol>{steps.map((step, index) => <li key={step} className={index < progress.completed || !busy && index === steps.length - 1 ? 'done' : index === progress.completed ? 'active' : ''}><span>{index < progress.completed || !busy && index === steps.length - 1 ? <Check size={10}/> : index + 1}</span>{step}</li>)}</ol>
    {busy && <div className="export-progress-actions"><button className="export-cancel" onClick={onCancel}><X size={13}/>Cancel export</button></div>}
  </section>;
}
