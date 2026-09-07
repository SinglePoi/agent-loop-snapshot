import type {
  ArtifactReference,
  ErrorInfo,
  JsonObject,
  JsonValue,
  SideEffectLevel,
} from '@agent-loop-snapshot/schema';

export type ReplayAdapterMode = 'live' | 'recorded';

export type ReplayAdapterKind = 'model' | 'tool' | 'clock' | 'random' | 'environment';

export type ReplayAdapterCapability =
  'model.complete' | 'tool.call' | 'clock.now' | 'random.next' | 'environment.read';

export interface ReplayAdapterDescriptor {
  readonly name: string;
  readonly version: string;
  readonly capabilities: readonly ReplayAdapterCapability[];
  readonly sideEffect: SideEffectLevel;
}

export interface ReplayInvocation {
  /** A stable key for one logical call; retries share this value. */
  readonly correlationKey: string;
  /** One-based execution attempt for the logical call. */
  readonly attempt: number;
  /** Source event IDs are optional provenance, never executable instructions. */
  readonly sourceEventIds?: readonly string[];
}

export type ReplayOutcome<T> =
  | { readonly status: 'completed'; readonly output: T }
  | { readonly status: 'failed'; readonly error: ErrorInfo };

export interface ReplayModelRequest extends ReplayInvocation {
  readonly model: string;
  readonly input: JsonValue | ArtifactReference;
}

export interface ReplayToolRequest extends ReplayInvocation {
  readonly tool: string;
  readonly arguments: JsonObject | ArtifactReference;
}

export type ReplayClockRequest = ReplayInvocation;

export interface ReplayRandomRequest extends ReplayInvocation {
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface ReplayEnvironmentRequest extends ReplayInvocation {
  readonly name: string;
}

export interface ReplayModelAdapter {
  readonly descriptor: ReplayAdapterDescriptor;
  complete(request: ReplayModelRequest): Promise<ReplayOutcome<JsonValue | ArtifactReference>>;
}

export interface ReplayToolAdapter {
  readonly descriptor: ReplayAdapterDescriptor;
  call(request: ReplayToolRequest): Promise<ReplayOutcome<JsonValue | ArtifactReference>>;
}

/** Returns an ISO-8601 timestamp so implementations do not leak a Date API. */
export interface ReplayClockAdapter {
  readonly descriptor: ReplayAdapterDescriptor;
  now(request: ReplayClockRequest): Promise<ReplayOutcome<string>>;
}

/** Returns a number in the requested range, if one was supplied. */
export interface ReplayRandomAdapter {
  readonly descriptor: ReplayAdapterDescriptor;
  next(request: ReplayRandomRequest): Promise<ReplayOutcome<number>>;
}

export interface ReplayEnvironmentAdapter {
  readonly descriptor: ReplayAdapterDescriptor;
  read(request: ReplayEnvironmentRequest): Promise<ReplayOutcome<string | undefined>>;
}

export interface ReplayAdapterSet {
  readonly model?: ReplayModelAdapter;
  readonly tools?: readonly ReplayToolAdapter[];
  readonly clock?: ReplayClockAdapter;
  readonly random?: ReplayRandomAdapter;
  readonly environment?: ReplayEnvironmentAdapter;
}

export type ReplayAdapterDiagnosticCode =
  'MISSING_ADAPTER' | 'AMBIGUOUS_TOOL_ADAPTER' | 'ADAPTER_CAPABILITY_MISSING';

export interface ReplayAdapterDiagnostic {
  readonly severity: 'error';
  readonly code: ReplayAdapterDiagnosticCode;
  readonly adapterKind: ReplayAdapterKind;
  readonly mode: ReplayAdapterMode;
  readonly message: string;
  readonly target?: string;
}

export interface ReplayAdapterResolution<T> {
  readonly adapter?: T;
  readonly diagnostics: readonly ReplayAdapterDiagnostic[];
}

export interface ReplayAdapterRegistryOptions {
  readonly live?: ReplayAdapterSet;
  readonly recorded?: ReplayAdapterSet;
}

function supports(
  descriptor: ReplayAdapterDescriptor,
  capability: ReplayAdapterCapability,
  adapterKind: ReplayAdapterKind,
  mode: ReplayAdapterMode,
  target?: string,
): ReplayAdapterResolution<never> | undefined {
  if (descriptor.capabilities.includes(capability)) {
    return undefined;
  }
  return {
    diagnostics: [
      {
        severity: 'error',
        code: 'ADAPTER_CAPABILITY_MISSING',
        adapterKind,
        mode,
        ...(target === undefined ? {} : { target }),
        message: `Adapter "${descriptor.name}" does not declare capability "${capability}".`,
      },
    ],
  };
}

function missingAdapter<T>(
  adapterKind: ReplayAdapterKind,
  mode: ReplayAdapterMode,
  target?: string,
): ReplayAdapterResolution<T> {
  return {
    diagnostics: [
      {
        severity: 'error',
        code: 'MISSING_ADAPTER',
        adapterKind,
        mode,
        ...(target === undefined ? {} : { target }),
        message:
          target === undefined
            ? `No ${mode} ${adapterKind} replay adapter is configured.`
            : `No ${mode} tool replay adapter is configured for "${target}".`,
      },
    ],
  };
}

function resolved<T>(
  adapter: T,
  descriptor: ReplayAdapterDescriptor,
  capability: ReplayAdapterCapability,
  adapterKind: ReplayAdapterKind,
  mode: ReplayAdapterMode,
  target?: string,
): ReplayAdapterResolution<T> {
  const unsupported = supports(descriptor, capability, adapterKind, mode, target);
  if (unsupported !== undefined) {
    return unsupported;
  }
  return { adapter, diagnostics: [] };
}

/**
 * Chooses a live or recorded implementation without coupling replay to a
 * model provider, tool framework, process clock, or environment API.
 */
export class ReplayAdapterRegistry {
  private readonly live: ReplayAdapterSet;
  private readonly recorded: ReplayAdapterSet;

  constructor(options: ReplayAdapterRegistryOptions = {}) {
    this.live = options.live ?? {};
    this.recorded = options.recorded ?? {};
  }

  resolveModel(mode: ReplayAdapterMode): ReplayAdapterResolution<ReplayModelAdapter> {
    const adapter = this.forMode(mode).model;
    return adapter === undefined
      ? missingAdapter('model', mode)
      : resolved(adapter, adapter.descriptor, 'model.complete', 'model', mode);
  }

  resolveTool(mode: ReplayAdapterMode, tool: string): ReplayAdapterResolution<ReplayToolAdapter> {
    const matches = (this.forMode(mode).tools ?? []).filter(
      (adapter) => adapter.descriptor.name === tool,
    );
    if (matches.length === 0) {
      return missingAdapter('tool', mode, tool);
    }
    if (matches.length > 1) {
      return {
        diagnostics: [
          {
            severity: 'error',
            code: 'AMBIGUOUS_TOOL_ADAPTER',
            adapterKind: 'tool',
            mode,
            target: tool,
            message: `More than one ${mode} tool replay adapter is configured for "${tool}".`,
          },
        ],
      };
    }
    const adapter = matches[0]!;
    return resolved(adapter, adapter.descriptor, 'tool.call', 'tool', mode, tool);
  }

  resolveClock(mode: ReplayAdapterMode): ReplayAdapterResolution<ReplayClockAdapter> {
    const adapter = this.forMode(mode).clock;
    return adapter === undefined
      ? missingAdapter('clock', mode)
      : resolved(adapter, adapter.descriptor, 'clock.now', 'clock', mode);
  }

  resolveRandom(mode: ReplayAdapterMode): ReplayAdapterResolution<ReplayRandomAdapter> {
    const adapter = this.forMode(mode).random;
    return adapter === undefined
      ? missingAdapter('random', mode)
      : resolved(adapter, adapter.descriptor, 'random.next', 'random', mode);
  }

  resolveEnvironment(mode: ReplayAdapterMode): ReplayAdapterResolution<ReplayEnvironmentAdapter> {
    const adapter = this.forMode(mode).environment;
    return adapter === undefined
      ? missingAdapter('environment', mode)
      : resolved(adapter, adapter.descriptor, 'environment.read', 'environment', mode);
  }

  private forMode(mode: ReplayAdapterMode): ReplayAdapterSet {
    return mode === 'live' ? this.live : this.recorded;
  }
}
