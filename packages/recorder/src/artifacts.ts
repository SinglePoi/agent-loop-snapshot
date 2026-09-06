import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { snapshotSchemaVersion } from '@agent-loop-snapshot/schema/protocol';
import type { ArtifactReference } from '@agent-loop-snapshot/schema';

const digestPattern = /^[a-f0-9]{64}$/;

export type ArtifactContent = Uint8Array | ArrayBuffer | string;

export interface PutArtifactOptions {
  mediaType: string;
  preview?: string;
}

export type ArtifactIntegrityCode =
  | 'VALID'
  | 'MISSING_ARTIFACT'
  | 'ARTIFACT_DIGEST_MISMATCH'
  | 'ARTIFACT_SIZE_MISMATCH'
  | 'INVALID_ARTIFACT_REFERENCE'
  | 'ARTIFACT_INVALID_ENTRY';

export interface ArtifactIntegrityReport {
  valid: boolean;
  code: ArtifactIntegrityCode;
  digest?: string;
  message: string;
}

export interface ArtifactReferenceDiagnostic {
  reference: ArtifactReference;
  report: ArtifactIntegrityReport;
}

export class ArtifactStoreError extends Error {
  constructor(
    readonly code: ArtifactIntegrityCode | 'INVALID_ARTIFACT_CONTENT' | 'INVALID_MEDIA_TYPE',
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactStoreError';
  }
}

function contentBuffer(content: ArtifactContent): Buffer {
  if (typeof content === 'string') {
    return Buffer.from(content, 'utf8');
  }

  if (content instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(content));
  }

  if (content instanceof Uint8Array) {
    return Buffer.from(content);
  }

  throw new ArtifactStoreError(
    'INVALID_ARTIFACT_CONTENT',
    'Artifact content must be a string, Uint8Array, or ArrayBuffer.',
  );
}

function digestFor(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

function invalidReferenceReport(reference: ArtifactReference): ArtifactIntegrityReport | undefined {
  if (reference.schema_version !== snapshotSchemaVersion) {
    return {
      valid: false,
      code: 'INVALID_ARTIFACT_REFERENCE',
      message: `Unsupported artifact schema version "${String(reference.schema_version)}".`,
    };
  }

  if (typeof reference.digest !== 'string' || !digestPattern.test(reference.digest)) {
    return {
      valid: false,
      code: 'INVALID_ARTIFACT_REFERENCE',
      message: 'Artifact digest must be a lowercase 64-character SHA-256 hex string.',
    };
  }

  if (typeof reference.media_type !== 'string' || reference.media_type.length === 0) {
    return {
      valid: false,
      digest: reference.digest,
      code: 'INVALID_ARTIFACT_REFERENCE',
      message: 'Artifact media_type must be a non-empty string.',
    };
  }

  if (!Number.isSafeInteger(reference.byte_length) || reference.byte_length < 0) {
    return {
      valid: false,
      digest: reference.digest,
      code: 'INVALID_ARTIFACT_REFERENCE',
      message: 'Artifact byte_length must be a non-negative safe integer.',
    };
  }

  return undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export class ArtifactStore {
  private readonly directory: string;
  private readonly writeQueues = new Map<string, Promise<void>>();

  private constructor(directory: string) {
    this.directory = resolve(directory);
  }

  static async open(directory: string): Promise<ArtifactStore> {
    const store = new ArtifactStore(directory);
    await mkdir(store.directory, { recursive: true });
    return store;
  }

  async put(content: ArtifactContent, options: PutArtifactOptions): Promise<ArtifactReference> {
    if (typeof options.mediaType !== 'string' || options.mediaType.length === 0) {
      throw new ArtifactStoreError('INVALID_MEDIA_TYPE', 'Artifact mediaType must be non-empty.');
    }
    if (options.preview !== undefined && typeof options.preview !== 'string') {
      throw new ArtifactStoreError(
        'INVALID_ARTIFACT_CONTENT',
        'Artifact preview must be a string.',
      );
    }

    const contents = contentBuffer(content);
    const digest = digestFor(contents);
    const reference: ArtifactReference = {
      schema_version: snapshotSchemaVersion,
      digest,
      media_type: options.mediaType,
      byte_length: contents.byteLength,
      ...(options.preview === undefined ? {} : { preview: options.preview }),
    };

    return this.enqueueDigest(digest, async () => {
      const existing = await this.verify(reference);
      if (existing.valid) {
        return reference;
      }
      if (existing.code !== 'MISSING_ARTIFACT') {
        throw new ArtifactStoreError(existing.code, existing.message);
      }

      const targetPath = this.pathForDigest(digest);
      const temporaryPath = join(this.directory, `.sha256-${digest}.${randomUUID()}.tmp`);
      let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;

      try {
        temporaryHandle = await open(temporaryPath, 'wx');
        await temporaryHandle.writeFile(contents);
        await temporaryHandle.sync();
        await temporaryHandle.close();
        temporaryHandle = undefined;

        try {
          await rename(temporaryPath, targetPath);
        } catch (error) {
          const raced = await this.verify(reference);
          if (!raced.valid) {
            throw new ArtifactStoreError(
              raced.code,
              `Could not install artifact ${digest}: ${errorMessage(error, raced.message)}`,
            );
          }
        }
      } finally {
        await temporaryHandle?.close().catch(() => undefined);
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }

      return reference;
    });
  }

  async get(reference: ArtifactReference): Promise<Uint8Array> {
    const report = await this.verify(reference);
    if (!report.valid) {
      throw new ArtifactStoreError(report.code, report.message);
    }

    try {
      return new Uint8Array(await readFile(this.pathForDigest(reference.digest)));
    } catch (error) {
      throw new ArtifactStoreError(
        'ARTIFACT_INVALID_ENTRY',
        errorMessage(error, `Could not read artifact ${reference.digest}.`),
      );
    }
  }

  async verify(reference: ArtifactReference): Promise<ArtifactIntegrityReport> {
    const invalid = invalidReferenceReport(reference);
    if (invalid !== undefined) {
      return invalid;
    }

    const artifactPath = this.pathForDigest(reference.digest);
    let contents: Buffer;
    try {
      contents = await readFile(artifactPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        valid: false,
        digest: reference.digest,
        code: code === 'ENOENT' ? 'MISSING_ARTIFACT' : 'ARTIFACT_INVALID_ENTRY',
        message: errorMessage(error, `Could not read artifact ${reference.digest}.`),
      };
    }

    if (contents.byteLength !== reference.byte_length) {
      return {
        valid: false,
        digest: reference.digest,
        code: 'ARTIFACT_SIZE_MISMATCH',
        message: `Artifact has ${contents.byteLength} bytes, expected ${reference.byte_length}.`,
      };
    }

    const actualDigest = digestFor(contents);
    if (actualDigest !== reference.digest) {
      return {
        valid: false,
        digest: reference.digest,
        code: 'ARTIFACT_DIGEST_MISMATCH',
        message: `Artifact digest ${actualDigest} does not match declared digest ${reference.digest}.`,
      };
    }

    return {
      valid: true,
      digest: reference.digest,
      code: 'VALID',
      message: 'Artifact is present and matches its declared digest and byte length.',
    };
  }

  async verifyReferences(
    references: readonly ArtifactReference[],
  ): Promise<ArtifactReferenceDiagnostic[]> {
    return Promise.all(
      references.map(async (reference) => ({
        reference,
        report: await this.verify(reference),
      })),
    );
  }

  async listArtifacts(): Promise<readonly string[]> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^sha256-[a-f0-9]{64}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  pathFor(reference: ArtifactReference): string {
    const invalid = invalidReferenceReport(reference);
    if (invalid !== undefined) {
      throw new ArtifactStoreError(invalid.code, invalid.message);
    }
    return this.pathForDigest(reference.digest);
  }

  private pathForDigest(digest: string): string {
    if (!digestPattern.test(digest)) {
      throw new ArtifactStoreError(
        'INVALID_ARTIFACT_REFERENCE',
        'Artifact digest must be a lowercase 64-character SHA-256 hex string.',
      );
    }
    return join(this.directory, `sha256-${digest}`);
  }

  private enqueueDigest<T>(digest: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(digest) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.writeQueues.set(digest, settled);
    void settled.then(() => {
      if (this.writeQueues.get(digest) === settled) {
        this.writeQueues.delete(digest);
      }
    });
    return result;
  }
}
