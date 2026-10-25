import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import config from '../vite.config.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetAllMocks(); });

function buildFor(command: 'build' | 'serve') {
  if (typeof config !== 'function') throw new Error('Expected a Vite config factory');
  const resolved = config({ command, mode: command === 'build' ? 'production' : 'development', isSsrBuild: false, isPreview: false });
  return JSON.parse(resolved.define!.__MARKROOT_BUILD__ as string) as { date: string; timestamp: string; commit?: string };
}

it('stamps a production artifact in UTC and prefers the CI SHA', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-25T23:30:00-04:00'));
  vi.stubEnv('GITHUB_SHA', 'abcdef1234567890');
  expect(buildFor('build')).toEqual({ date: '2026-10-26', timestamp: '2026-10-26T03:30:00.000Z', commit: 'abcdef1' });
  expect(execFileSync).not.toHaveBeenCalled();
});

it('uses local git when available, dev in the server, and tolerates source archives', () => {
  vi.stubEnv('GITHUB_SHA', ''); vi.mocked(execFileSync).mockReturnValue('123abcd\n');
  expect(buildFor('serve')).toMatchObject({ date: 'dev', commit: '123abcd' });
  vi.mocked(execFileSync).mockImplementation(() => { throw new Error('No git metadata'); });
  const build = buildFor('build');
  expect(build.date).toMatch(/^\d{4}-\d{2}-\d{2}$/); expect(build.commit).toBeUndefined();
});
