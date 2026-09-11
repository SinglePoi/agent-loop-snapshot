import { AsyncLocalStorage } from 'node:async_hooks';

import type { Recorder, SnapshotWriter, RunHandle } from '@agent-loop-snapshot/recorder';
import type { EventId } from '@agent-loop-snapshot/schema';

/** The durable run resources shared by generic and SDK integrations. */
export interface InstrumentationRun {
  readonly recorder: Recorder;
  readonly run: RunHandle;
  readonly snapshotDirectory: string;
  readonly writer: SnapshotWriter;
}

export interface InstrumentationScope {
  readonly activeRun: InstrumentationRun;
  readonly parentIds: readonly EventId[];
  /**
   * Undefined means a generic root run, which deliberately permits every
   * installed SDK integration. A controller-owned run limits capture to the
   * integration objects that controller acquired.
   */
  readonly allowedIntegrations: ReadonlySet<object> | undefined;
  /** True while generic instrument() owns or has joined the current run. */
  readonly generic: boolean;
  readonly suppressed: boolean;
}

const scopes = new AsyncLocalStorage<InstrumentationScope>();
const pendingOperations = new WeakMap<RunHandle, Set<Promise<unknown>>>();

export function currentInstrumentationScope(): InstrumentationScope | undefined {
  return scopes.getStore();
}

export function runWithInstrumentationScope<T>(scope: InstrumentationScope, operation: () => T): T {
  return scopes.run(scope, operation);
}

/** Suppression retains the active run for nested bookkeeping but hides it from SDK wrappers. */
export function runWithInstrumentationSuppression<T>(operation: () => T): T {
  const scope = scopes.getStore();
  if (scope === undefined) {
    return operation();
  }
  return scopes.run({ ...scope, suppressed: true }, operation);
}

/**
 * Registers work that writes to the active run after a wrapper has returned.
 * Controllers drain this set before emitting their terminal observation.
 */
export function trackInstrumentationOperation<T>(
  activeRun: InstrumentationRun,
  operation: Promise<T>,
): Promise<T> {
  const pending = pendingOperations.get(activeRun.run) ?? new Set<Promise<unknown>>();
  pendingOperations.set(activeRun.run, pending);
  pending.add(operation);
  void operation.then(
    () => pending.delete(operation),
    () => pending.delete(operation),
  );
  return operation;
}

/** Returns false only when tracked work remains past the bounded deadline. */
export async function drainInstrumentationOperations(
  activeRun: InstrumentationRun,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const pending = pendingOperations.get(activeRun.run);
  while (pending !== undefined && pending.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    const settled = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), remaining);
      void Promise.allSettled([...pending]).then(() => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    if (!settled) {
      return false;
    }
  }
  return true;
}
