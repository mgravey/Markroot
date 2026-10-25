const build = typeof __MARKROOT_BUILD__ === 'undefined' ? { date: 'dev', timestamp: '', commit: undefined } : __MARKROOT_BUILD__;
const tooltip = [build.date === 'dev' ? 'Development server' : `Built ${build.timestamp} (UTC)`, build.commit && `Commit ${build.commit}`].filter(Boolean).join(' · ');

export function BuildInfo({ full = false }: { full?: boolean }) {
  return <span className="build-info" title={tooltip}>{full ? `Markroot · build ${build.date}${build.commit ? ` · ${build.commit}` : ''}` : `Build ${build.date}`}</span>;
}
