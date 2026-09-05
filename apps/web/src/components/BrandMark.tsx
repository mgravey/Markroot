interface BrandMarkProps {
  readonly className?: string;
  readonly title?: string;
}

/** Final frame of the Lottie/After Effects identity animation. */
export function BrandMark({ className, title }: BrandMarkProps) {
  return <svg className={className} viewBox="0 0 512 512" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
    {title && <title>{title}</title>}
    <path fill="currentColor" d="M144 48h224c53 0 96 43 96 96v256c0 35-29 64-64 64H144c-53 0-96-43-96-96V144c0-53 43-96 96-96Z"/>
    <g fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="32">
      <path d="M326 156H232c-52 0-84 27-84 72s32 72 84 72h30"/>
      <path d="M262 156v190"/>
      <path d="M326 156v144"/>
      <path d="M262 346 205 382M262 346v53M262 346l59 36"/>
    </g>
    <path className="brand-cursor" fill="#ef9163" d="M354 128h24v64h-24z"/>
  </svg>;
}
