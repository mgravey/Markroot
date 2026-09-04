import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';

interface Props {
  className?: string;
  label: string;
  value: number;
  min: number;
  max: number;
  keyboardStep: number;
  pixelsPerUnit?: () => number;
  onChange(value: number, finished: boolean): void;
}

export function PaneResizer({ className = '', label, value, min, max, keyboardStep, pixelsPerUnit = () => 1, onChange }: Props) {
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const origin = event.clientX;
    const initial = value;
    const scale = Math.max(1, pixelsPerUnit());
    const move = (next: PointerEvent) => onChange(clamp(initial + (next.clientX - origin) / scale, min, max), false);
    const finish = (next: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      onChange(clamp(initial + (next.clientX - origin) / scale, min, max), true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
  };
  const keyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    onChange(clamp(value + (event.key === 'ArrowRight' ? keyboardStep : -keyboardStep), min, max), true);
  };
  return <div className={`pane-resizer ${className}`} role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} tabIndex={0} onPointerDown={start} onKeyDown={keyboard}><span/></div>;
}

export function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
