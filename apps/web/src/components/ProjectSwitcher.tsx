import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Files, FolderOpen, X } from 'lucide-react';
import type { RecentProject } from '@markroot/settings';
import { useEvent } from '../hooks/useEvent.js';
import { projectLabels, projectParentHints } from './project-labels.js';

interface ProjectsProps {
  projects: readonly RecentProject[];
  onSelect(project: RecentProject): void;
  onRemove(id: string): void;
}

function useProjectLabels(projects: readonly RecentProject[]) {
  const [parents, setParents] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let disposed = false;
    void projectParentHints(projects).then((hints) => { if (!disposed) setParents(hints); }).catch(() => undefined);
    return () => { disposed = true; };
  }, [projects]);
  return projectLabels(projects, parents);
}

export function ProjectSwitcher({ projects, currentId, rootName, onSelect, onRemove, onOpen }: ProjectsProps & { currentId: string | undefined; rootName: string; onOpen(): void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const labels = useProjectLabels(projects);
  const close = (focus = true) => { setOpen(false); if (focus) trigger.current?.focus(); };
  const shortcut = useEvent((event: globalThis.KeyboardEvent) => {
    if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== 'o') return;
    event.preventDefault(); setOpen(true);
  });
  useEffect(() => {
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [shortcut]);
  useEffect(() => {
    if (!open) return;
    const selected = menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    (selected ?? menu.current?.querySelector<HTMLButtonElement>('button'))?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') { close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  return <div className="project-switcher" ref={container} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} className="workspace-button" title="Switch project (Ctrl/Cmd+Shift+O)" aria-label={`Switch project: ${rootName}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen((value) => !value)} onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}><Files size={16}/><span>{rootName}</span><ChevronDown size={14}/></button>
    {open && <div className="project-menu" ref={menu} id={menuId} role="menu" aria-label="Projects" onKeyDown={navigate}>
      <div className="project-menu-heading" role="presentation">Recent projects</div>
      {labels.map(({ project, hint }) => <div className="project-row" role="presentation" key={project.id}>
        <button role="menuitemradio" aria-checked={project.id === currentId} tabIndex={-1} className="project-select" onClick={() => { onSelect(project); close(); }}><span className="project-check">{project.id === currentId && <Check size={15}/>}</span><span className="project-label"><span>{project.name}</span>{hint && <small>{hint}</small>}</span></button>
        <button role="menuitem" tabIndex={-1} className="project-remove" aria-label={`Remove ${project.name}${hint ? ` (${hint})` : ''} from list`} title="Remove from list" onClick={() => { const next = menu.current?.querySelector<HTMLButtonElement>('.project-open'); onRemove(project.id); next?.focus(); }}><X size={14}/></button>
      </div>)}
      {!projects.length && <p className="project-menu-empty" role="presentation">No recent projects</p>}
      <button role="menuitem" tabIndex={-1} className="project-open" onClick={() => { onOpen(); close(); }}><FolderOpen size={16}/>Open folder…</button>
    </div>}
  </div>;
}

export function RecentProjects({ projects, onSelect, onRemove }: ProjectsProps) {
  const labels = useProjectLabels(projects);
  if (!projects.length) return null;
  return <section className="recent-projects" aria-label="Recent projects"><h2>Recent projects</h2>{labels.map(({ project, hint }) => <div className="project-row" key={project.id}>
    <button className="project-select" onClick={() => onSelect(project)}><FolderOpen size={16}/><span className="project-label"><span>{project.name}</span>{hint && <small>{hint}</small>}</span></button>
    <button className="project-remove" aria-label={`Remove ${project.name}${hint ? ` (${hint})` : ''} from list`} title="Remove from list" onClick={() => onRemove(project.id)}><X size={14}/></button>
  </div>)}</section>;
}
