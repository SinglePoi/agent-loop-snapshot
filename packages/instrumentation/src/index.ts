import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  Recorder,
  SnapshotWriter,
  createDefaultRedactionPipeline,
} from '@agent-loop-snapshot/recorder';
import type { EventId, JsonValue, RuntimeDescriptor } from '@agent-loop-snapshot/schema';

import {
  currentInstrumentationScope,
  drainInstrumentationOperations,
  runWithInstrumentationScope,
  runWithInstrumentationSuppression,
  trackInstrumentationOperation,
  type InstrumentationRun,
} from './context.js';

export const instrumentationPackageName = '@agent-loop-snapshot/instrumentation' as const;

export type RecordingFailureMode = 'strict' | 'best-effort';

export interface InstrumentationDiagnostic {
  readonly code:
    | 'INTEGRATION_OUTSIDE_RUN'
    | 'RECORDING_SETUP_FAILED'
    | 'RECORDING_FINALIZATION_FAILED'
    | 'DIAGNOSTIC_CALLBACK_FAILED';
  readonly message: string;
  readonly integration?: string;
}

export class InstrumentationError extends Error {
  constructor(
    readonly code:
      | 'NESTED_RUN_NOT_SUPPORTED'
      | 'INSTRUMENTATION_SHUTDOWN'
      | 'PATCH_TARGET_NOT_CALLABLE'
      | 'PATCH_TARGET_NOT_WRITABLE',
    message: string,
  ) {
    super(message);
    this.name = 'InstrumentationError';
  }
}

export type InstrumentedMethod = (this: unknown, ...args: unknown[]) => unknown;

export interface MethodInvocation {
  readonly original: InstrumentedMethod;
  readonly thisArg: unknown;
  readonly args: readonly unknown[];
}

/**
 * Wraps an own, writable SDK method and restores it only when no later code
 * has replaced the method. This is the coexistence boundary used by vendor
 * integrations: an uninstall can never clobber another instrumenter.
 */
export function patchMethod(
  target: object,
  property: PropertyKey,
  interceptor: (invocation: MethodInvocation) => unknown,
): () => boolean {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  if (descriptor === undefined || typeof descriptor.value !== 'function') {
    throw new InstrumentationError(
      'PATCH_TARGET_NOT_CALLABLE',
      `Cannot instrument ${String(property)} because it is not an own callable method.`,
    );
  }
  if (descriptor.writable !== true) {
    throw new InstrumentationError(
      'PATCH_TARGET_NOT_WRITABLE',
      `Cannot instrument ${String(property)} because the method is not writable.`,
    );
  }

  const original = descriptor.value as InstrumentedMethod;
  const replacement = function (this: unknown, ...args: unknown[]): unknown {
    return interceptor({ original, thisArg: this, args });
  };
  Object.defineProperty(target, property, { ...descriptor, value: replacement });

  return () => {
    const current = Object.getOwnPropertyDescriptor(target, property);
    if (current?.value !== replacement) {
      return false;
    }
    Object.defineProperty(target, property, descriptor);
    return true;
  };
}

export type InstrumentedRun = InstrumentationRun;

/**
 * The intentionally small contract used by vendor packages. CAP-05 adapters
 * install their own narrowly-targeted SDK wrappers; this package never
 * changes Node's module loader or an application's global OTel provider.
 */
export interface InstrumentationIntegrationApi {
  currentRun(): InstrumentedRun | undefined;
  /** The proven parent relationship for a call in the current async scope. */
  currentParentIds(): readonly EventId[] | undefined;
  isSuppressed(): boolean;
  withSuppression<T>(operation: () => T): T;
  /** Track an SDK wrapper promise so telemetry.run() cannot close it early. */
  track<T>(operation: Promise<T>): Promise<T>;
  reportDiagnostic(diagnostic: InstrumentationDiagnostic): void;
}

export type IntegrationTeardown = () => void;

export interface InstrumentationIntegration {
  readonly name: string;
  install(api: InstrumentationIntegrationApi): void | IntegrationTeardown;
}

export interface InitInstrumentationOptions {
  /** Parent directory. Every invocation of run creates its own random child. */
  readonly snapshotDir: string;
  readonly runtime?: RuntimeDescriptor;
  readonly integrations?: readonly InstrumentationIntegration[];
  /** SDK integrations default to best-effort so recording never changes business results. */
  readonly recordingFailure?: RecordingFailureMode;
  /** Maximum wait for SDK wrapper work started but not awaited by the callback. */
  readonly drainTimeoutMs?: number;
  readonly onDiagnostic?: (diagnostic: InstrumentationDiagnostic) => void;
}

export interface InstrumentationController {
  run<T>(options: { readonly input?: JsonValue }, operation: () => T | Promise<T>): Promise<T>;
  shutdown(): Promise<void>;
}

interface InstalledIntegration {
  refs: number;
  teardown: IntegrationTeardown | undefined;
  readonly reporters: Set<(diagnostic: InstrumentationDiagnostic) => void>;
  outsideRunReported: boolean;
}

const installedIntegrations = new WeakMap<InstrumentationIntegration, InstalledIntegration>();

function reportIntegrationDiagnostic(
  installed: InstalledIntegration,
  diagnostic: InstrumentationDiagnostic,
): void {
  for (const report of installed.reporters) {
    report(diagnostic);
  }
}

function safeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback;
}

class Controller implements InstrumentationController {
  private readonly snapshotDir: string;
  private readonly runtime: RuntimeDescriptor;
  private readonly recordingFailure: RecordingFailureMode;
  private readonly drainTimeoutMs: number;
  private readonly onDiagnostic: ((diagnostic: InstrumentationDiagnostic) => void) | undefined;
  private readonly integrations: readonly InstrumentationIntegration[];
  private readonly activeRuns = new Set<Promise<unknown>>();
  private readonly integrationReporter = (diagnostic: InstrumentationDiagnostic): void =>
    this.reportDiagnostic(diagnostic);
  private closed = false;

  constructor(options: InitInstrumentationOptions) {
    this.snapshotDir = resolve(options.snapshotDir);
    this.runtime = options.runtime ?? {
      name: 'agent-loop-sdk-instrumentation',
      version: '0.1.0',
      adapter: instrumentationPackageName,
    };
    this.recordingFailure = options.recordingFailure ?? 'best-effort';
    this.drainTimeoutMs = Math.max(0, Math.floor(options.drainTimeoutMs ?? 5_000));
    this.onDiagnostic = options.onDiagnostic;
    this.integrations = [...new Set(options.integrations ?? [])];

    const acquired: InstrumentationIntegration[] = [];
    try {
      for (const integration of this.integrations) {
        this.acquire(integration);
        acquired.push(integration);
      }
    } catch (error) {
      for (const integration of acquired.reverse()) {
        this.release(integration);
      }
      throw error;
    }
  }

  run<T>(options: { readonly input?: JsonValue }, operation: () => T | Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new InstrumentationError(
          'INSTRUMENTATION_SHUTDOWN',
          'Instrumentation has already been shut down; it cannot start another run.',
        ),
      );
    }
    if (currentInstrumentationScope() !== undefined) {
      return Promise.reject(
        new InstrumentationError(
          'NESTED_RUN_NOT_SUPPORTED',
          'Nested instrumentation runs are not supported. Reuse the current run context instead.',
        ),
      );
    }

    const pending = this.runInternal(options, operation);
    this.activeRuns.add(pending);
    void pending.then(
      () => this.activeRuns.delete(pending),
      () => this.activeRuns.delete(pending),
    );
    return pending;
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await Promise.allSettled([...this.activeRuns]);
    for (const integration of [...this.integrations].reverse()) {
      this.release(integration);
    }
  }

  private acquire(integration: InstrumentationIntegration): void {
    const existing = installedIntegrations.get(integration);
    if (existing !== undefined) {
      existing.refs += 1;
      existing.reporters.add(this.integrationReporter);
      return;
    }

    const installed: InstalledIntegration = {
      refs: 1,
      teardown: undefined,
      reporters: new Set([this.integrationReporter]),
      outsideRunReported: false,
    };
    const installationResult = integration.install({
      currentRun: () => {
        const scope = currentInstrumentationScope();
        if (scope?.suppressed === true) {
          return undefined;
        }
        if (scope === undefined) {
          if (!installed.outsideRunReported) {
            installed.outsideRunReported = true;
            reportIntegrationDiagnostic(installed, {
              code: 'INTEGRATION_OUTSIDE_RUN',
              integration: integration.name,
              message: `Integration "${integration.name}" ignored an SDK call outside telemetry.run().`,
            });
          }
          return undefined;
        }
        if (
          scope.allowedIntegrations !== undefined &&
          !scope.allowedIntegrations.has(integration)
        ) {
          return undefined;
        }
        return scope.activeRun;
      },
      currentParentIds: () => {
        const scope = currentInstrumentationScope();
        if (scope === undefined || scope.suppressed) {
          return undefined;
        }
        if (
          scope.allowedIntegrations !== undefined &&
          !scope.allowedIntegrations.has(integration)
        ) {
          return undefined;
        }
        return scope.parentIds;
      },
      isSuppressed: () => currentInstrumentationScope()?.suppressed === true,
      withSuppression: <T>(operation: () => T): T => runWithInstrumentationSuppression(operation),
      track: <T>(operation: Promise<T>): Promise<T> => {
        const scope = currentInstrumentationScope();
        if (
          scope === undefined ||
          scope.suppressed ||
          (scope.allowedIntegrations !== undefined && !scope.allowedIntegrations.has(integration))
        ) {
          return operation;
        }
        return trackInstrumentationOperation(scope.activeRun, operation);
      },
      reportDiagnostic: (diagnostic) => reportIntegrationDiagnostic(installed, diagnostic),
    });
    installed.teardown = typeof installationResult === 'function' ? installationResult : undefined;
    installedIntegrations.set(integration, installed);
  }

  private release(integration: InstrumentationIntegration): void {
    const installed = installedIntegrations.get(integration);
    if (installed === undefined) {
      return;
    }
    installed.refs -= 1;
    installed.reporters.delete(this.integrationReporter);
    if (installed.refs !== 0) {
      return;
    }
    installedIntegrations.delete(integration);
    installed.teardown?.();
  }

  private async runInternal<T>(
    options: { readonly input?: JsonValue },
    operation: () => T | Promise<T>,
  ): Promise<T> {
    let activeRun: InstrumentedRun | undefined;
    try {
      activeRun = await this.createRun(options);
    } catch (error) {
      this.reportDiagnostic({
        code: 'RECORDING_SETUP_FAILED',
        message: `Could not start SDK recording: ${safeErrorMessage(error, 'unknown error')}`,
      });
      if (this.recordingFailure === 'strict') {
        throw error;
      }
      return operation();
    }

    let value: T | undefined;
    let businessError: unknown;
    try {
      value = await runWithInstrumentationScope(
        {
          activeRun,
          parentIds: [activeRun.run.startedEvent.event_id],
          allowedIntegrations: new Set<object>(this.integrations),
          generic: false,
          suppressed: false,
        },
        operation,
      );
    } catch (error) {
      businessError = error;
    }

    const drained = await drainInstrumentationOperations(activeRun, this.drainTimeoutMs);
    if (!drained && activeRun.run.status === 'running') {
      activeRun.recorder.markIncomplete(activeRun.run, {
        code: 'drain_timed_out',
        message: `SDK wrapper work did not settle within ${this.drainTimeoutMs}ms.`,
      });
    }
    if (businessError !== undefined) {
      await this.finishFailedRun(activeRun);
      throw businessError;
    }

    try {
      await activeRun.recorder.observeRun(activeRun.run, { outcome: 'completed' });
      await activeRun.writer.commit(activeRun.recorder.getManifest(activeRun.run));
    } catch (error) {
      await this.closeRun(activeRun);
      this.reportDiagnostic({
        code: 'RECORDING_FINALIZATION_FAILED',
        message: `Could not finalize SDK recording: ${safeErrorMessage(error, 'unknown error')}`,
      });
      if (this.recordingFailure === 'strict') {
        throw error;
      }
      return value as T;
    }

    await this.closeRun(activeRun);
    return value as T;
  }

  private async createRun(options: { readonly input?: JsonValue }): Promise<InstrumentedRun> {
    const snapshotDirectory = await this.createRunDirectory();
    const writer = await SnapshotWriter.open(snapshotDirectory);
    const recorder = new Recorder({
      interceptors: [createDefaultRedactionPipeline().asInterceptor(), writer.asInterceptor()],
    });
    try {
      const run = await recorder.startRun({
        runtime: this.runtime,
        ...(options.input === undefined ? {} : { input: options.input }),
        source: 'sdk',
        completeness: 'partial',
        limitations: [
          {
            code: 'final_state_unavailable',
            message: 'SDK instrumentation does not capture application final state.',
          },
        ],
      });
      await writer.writeManifest(recorder.getManifest(run));
      return { recorder, run, snapshotDirectory, writer };
    } catch (error) {
      await writer.close().catch(() => undefined);
      throw error;
    }
  }

  private async finishFailedRun(activeRun: InstrumentedRun): Promise<void> {
    try {
      await activeRun.recorder.failRun(activeRun.run, {
        code: 'INSTRUMENTED_CALLBACK_FAILED',
        message:
          'The instrumented callback failed; the original error remains available to its caller.',
        retryable: false,
        kind: 'runtime',
      });
      await activeRun.writer.commit(activeRun.recorder.getManifest(activeRun.run));
    } catch (recordingError) {
      this.reportDiagnostic({
        code: 'RECORDING_FINALIZATION_FAILED',
        message: `Could not record callback failure: ${safeErrorMessage(recordingError, 'unknown error')}`,
      });
    } finally {
      await this.closeRun(activeRun);
    }
  }

  private async createRunDirectory(): Promise<string> {
    await mkdir(this.snapshotDir, { recursive: true });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const directory = join(this.snapshotDir, `run-${randomUUID()}`);
      try {
        await mkdir(directory);
        return directory;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
    }
    throw new Error('Could not allocate a unique snapshot directory.');
  }

  private async closeRun(activeRun: InstrumentedRun): Promise<void> {
    await activeRun.writer.close().catch((error: unknown) => {
      this.reportDiagnostic({
        code: 'RECORDING_FINALIZATION_FAILED',
        message: `Could not close SDK recording: ${safeErrorMessage(error, 'unknown error')}`,
      });
    });
  }

  private reportDiagnostic(diagnostic: InstrumentationDiagnostic): void {
    try {
      this.onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostic handlers are observer-only and must never alter application behavior.
    }
  }
}

/** Installs the supplied integrations synchronously and returns their run scope. */
export function initInstrumentation(
  options: InitInstrumentationOptions,
): InstrumentationController {
  return new Controller(options);
}

export * from './instrument.js';
export * from './stream.js';
