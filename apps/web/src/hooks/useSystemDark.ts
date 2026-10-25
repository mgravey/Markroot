import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-color-scheme: dark)';
function subscribe(listener: () => void): () => void {
  const media = matchMedia(QUERY);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}
function systemDark(): boolean { return matchMedia(QUERY).matches; }

/** Follows the OS colour scheme live, so the 'system' theme switches without a reload. */
export function useSystemDark(): boolean { return useSyncExternalStore(subscribe, systemDark, () => false); }
