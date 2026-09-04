export type WorkspacePath = string & { readonly __workspacePath: unique symbol };

export function workspacePath(value: string): WorkspacePath {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.endsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new MarkrootError('INVALID_PATH', `Unsafe workspace path: ${value}`);
  }
  return normalized as WorkspacePath;
}

/** Resolve a document-relative URL path without allowing it to escape the workspace root. */
export function resolveWorkspaceReference(documentPath: WorkspacePath, reference: string): WorkspacePath {
  const unwrapped = reference.trim().replace(/^<([\s\S]*)>$/, '$1');
  const pathOnly = unwrapped.split(/[?#]/, 1)[0] ?? '';
  let decoded: string;
  try { decoded = decodeURIComponent(pathOnly); }
  catch (cause) { throw new MarkrootError('INVALID_PATH', `Invalid encoded workspace reference: ${reference}`, undefined, { cause }); }
  const absoluteFromRoot = decoded.startsWith('/');
  const parts = absoluteFromRoot ? [] : documentPath.split('/').slice(0, -1);
  for (const part of decoded.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new MarkrootError('INVALID_PATH', `Workspace reference escapes the selected folder: ${reference}`);
      parts.pop();
    } else parts.push(part);
  }
  return workspacePath(parts.join('/'));
}

/** Create the shortest portable path from a document to another workspace entry. */
export function relativeWorkspaceReference(documentPath: WorkspacePath, targetPath: WorkspacePath): string {
  const from = documentPath.split('/').slice(0, -1);
  const target = targetPath.split('/');
  let common = 0;
  while (common < from.length && common < target.length && from[common] === target[common]) common += 1;
  return [...Array(from.length - common).fill('..'), ...target.slice(common)].join('/');
}

export type ErrorCode =
  | 'ABORTED'
  | 'CONFLICT'
  | 'INVALID_PATH'
  | 'NOT_FOUND'
  | 'NOT_SUPPORTED'
  | 'PERMISSION_DENIED'
  | 'STALE_REVISION'
  | 'WORKSPACE_ERROR'
  | 'GIT_ERROR'
  | 'RENDER_ERROR'
  | 'EXPORT_ERROR';

export class MarkrootError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MarkrootError';
  }
}

export interface OperationContext {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ProgressEvent) => void;
}

export interface ProgressEvent {
  readonly phase: string;
  readonly completed: number;
  readonly total?: number;
  readonly message?: string;
}

export interface SourceRange {
  readonly from: number;
  readonly to: number;
}

export interface Revisioned {
  readonly revision: number;
}

export interface AuthorIdentity {
  readonly actorId: string;
  readonly displayName: string;
  readonly email?: string;
}

export function throwIfAborted(context?: OperationContext): void {
  if (context?.signal?.aborted) throw new MarkrootError('ABORTED', 'Operation cancelled.');
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
