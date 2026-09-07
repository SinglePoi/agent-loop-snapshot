import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface SnapshotPathBoundary {
  /** The lexical directory requested by the caller. */
  readonly directory: string;
  /** The resolved directory used to contain links encountered during reads. */
  readonly realDirectory: string;
}

export interface TrustedSnapshotPath {
  readonly path: string;
  readonly realPath: string;
  readonly size: number;
}

export type TrustedSnapshotPathKind = 'file' | 'directory';

export class SnapshotPathError extends Error {
  constructor(
    readonly code: 'MISSING' | 'OUTSIDE_SNAPSHOT' | 'UNTRUSTED_ENTRY',
    message: string,
  ) {
    super(message);
    this.name = 'SnapshotPathError';
  }
}

function isWithin(directory: string, candidate: string): boolean {
  const path = relative(directory, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

/**
 * Establishes the actual directory boundary once so every Loader and Validator
 * read can verify that resolving directory links still stays under it.
 */
export async function createSnapshotPathBoundary(directory: string): Promise<SnapshotPathBoundary> {
  const resolvedDirectory = resolve(directory);
  let realDirectory: string;
  try {
    realDirectory = await realpath(resolvedDirectory);
  } catch {
    // Later individual reads preserve their existing missing-file diagnostics.
    realDirectory = resolvedDirectory;
  }
  return { directory: resolvedDirectory, realDirectory };
}

/**
 * Rejects paths outside the snapshot's resolved boundary, links at the final
 * path component, and anything other than the expected regular entry type.
 */
export async function inspectSnapshotPath(
  boundary: SnapshotPathBoundary,
  candidate: string,
  kind: TrustedSnapshotPathKind,
): Promise<TrustedSnapshotPath> {
  const path = resolve(candidate);
  if (!isWithin(boundary.directory, path)) {
    throw new SnapshotPathError(
      'OUTSIDE_SNAPSHOT',
      `Snapshot path "${path}" is outside the selected snapshot directory.`,
    );
  }

  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    throw new SnapshotPathError(
      'MISSING',
      error instanceof Error ? error.message : `Snapshot path "${path}" is missing.`,
    );
  }

  const expectedKind = kind === 'file' ? entry.isFile() : entry.isDirectory();
  if (!expectedKind || entry.isSymbolicLink()) {
    throw new SnapshotPathError(
      'UNTRUSTED_ENTRY',
      `Snapshot ${kind} "${path}" must be a regular non-link ${kind}.`,
    );
  }

  let realPath: string;
  try {
    realPath = await realpath(path);
  } catch (error) {
    throw new SnapshotPathError(
      'MISSING',
      error instanceof Error ? error.message : `Snapshot path "${path}" is missing.`,
    );
  }
  if (!isWithin(boundary.realDirectory, realPath)) {
    throw new SnapshotPathError(
      'OUTSIDE_SNAPSHOT',
      `Snapshot ${kind} "${path}" resolves outside the selected snapshot directory.`,
    );
  }

  return { path, realPath, size: entry.size };
}
