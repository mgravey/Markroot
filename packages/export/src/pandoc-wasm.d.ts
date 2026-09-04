declare module 'pandoc-wasm' {
  export interface PandocResult {
    stdout: string;
    warnings: unknown[];
    files: Record<string, string | Blob>;
  }
  export function convert(options: Record<string, unknown>, stdin: string | null, files: Record<string, string | Blob>): Promise<PandocResult>;
}
