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
    const next = keyboardValue(event.key, value, min, max, keyboardStep);
    if (next === undefined) return;
    event.preventDefault();
    onChange(next, true);
  };
  const aria = separatorAria(value, min, max);
  return <div className={`pane-resizer ${className}`} role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={aria.min} aria-valuemax={aria.max} aria-valuenow={aria.now} aria-valuetext={aria.text} tabIndex={0} onPointerDown={start} onKeyDown={keyboard}><span/></div>;
}

/** Arrow keys step (up/right grow the leading pane), Home/End jump to the bounds; undefined for other keys. */
export function keyboardValue(key: string, value: number, min: number, max: number, step: number): number | undefined {
  if (key === 'ArrowRight' || key === 'ArrowUp') return clamp(value + step, min, max);
  if (key === 'ArrowLeft' || key === 'ArrowDown') return clamp(value - step, min, max);
  if (key === 'Home') return min;
  if (key === 'End') return max;
  return undefined;
}

/** Ratios (bounds within 0..1) are announced as whole percentages; pixel widths as rounded pixels. */
export function separatorAria(value: number, min: number, max: number): { min: number; max: number; now: number; text: string } {
  if (max <= 1) {
    const now = Math.round(clamp(value, min, max) * 100);
    return { min: Math.round(min * 100), max: Math.round(max * 100), now, text: `${now}%` };
  }
  const now = Math.round(clamp(value, min, max));
  return { min, max, now, text: `${now} pixels` };
}

export function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
