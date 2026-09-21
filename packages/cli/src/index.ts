#!/usr/bin/env node

import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assessSnapshotExecution,
  readSnapshotObservationMetadata,
  validateSnapshotDirectory,
  type SnapshotManifest,
  type ValidationDiagnostic,
} from '@agent-loop-snapshot/schema';
import {
  projectGraph,
  type GraphFilter,
  type GraphNodeStatus,
  type GraphProjection,
  type GraphProjectionKind,
} from '@agent-loop-snapshot/graph';
import {
  loadTraceSnapshot,
  type TraceDiagnostic,
  type TraceSnapshot,
} from '@agent-loop-snapshot/trace';
import {
  Recorder,
  SnapshotWriter,
  createDefaultRedactionPipeline,
  type FieldRedactionRule,
} from '@agent-loop-snapshot/recorder';
import { MockReplayRunner } from '@agent-loop-snapshot/replay';
import { importOtlpTraces, toObservationSnapshot } from '@agent-loop-snapshot/otel-import';
import {
  createOtlpExporter,
  dryRunOtlpExport,
  isExportEndpointConfigured,
  type OtelExportConfig,
} from '@agent-loop-snapshot/otel-export';
import { startViewer } from '@agent-loop-snapshot/viewer';

export const cliPackageName = '@agent-loop-snapshot/cli' as const;
export const cliVersion = '0.1.2' as const;

export const cliExitCodes = {
  success: 0,
  runtimeError: 1,
  validationFailed: 2,
} as const;

function acceptedDelivery(delivery: {
  readonly state: string;
  readonly reliableState?: string;
}): boolean {
  return (
    delivery.state === 'accepted' &&
    (delivery.reliableState === undefined ||
      delivery.reliableState === 'accepted' ||
      delivery.reliableState === 'accepted_with_warnings')
  );
}

type CommandName =
  'validate' | 'inspect' | 'graph' | 'replay' | 'import-otel' | 'export-otel' | 'view';
type OutputFormat = 'text' | 'json' | 'mermaid';
type ReplayMode = 'mock';

const graphKinds = new Set<GraphProjectionKind>(['causal-dag', 'call-tree', 'timeline']);
const graphStatuses = new Set<GraphNodeStatus>([
  'started',
  'completed',
  'failed',
  'changed',
  'recorded',
  'checkpointed',
  'verified',
  'unknown',
]);

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface CliDiagnostic {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly source: string;
  readonly file?: string;
  readonly line?: number;
}

export interface InspectError {
  readonly event_id: string;
  readonly type: string;
  readonly sequence: number;
  readonly code: string;
  readonly retryable?: boolean;
  readonly kind?: string;
}

export interface InspectSummary {
  readonly run_id?: string;
  readonly run_state?: string;
  readonly terminal_status?: string | null;
  readonly source?: string;
  readonly completeness?: string;
  readonly limitations?: readonly { readonly code: string; readonly message: string }[];
  readonly execution_eligibility?: string;
  readonly runtime?: SnapshotManifest['runtime'];
  readonly event_count: number;
  readonly checkpoint_count: number;
  readonly artifact_count: number;
  readonly artifact_reference_count: number;
  readonly model_call_count: number;
  readonly tool_call_count: number;
  readonly failure_count: number;
  readonly actor_count: number;
  readonly actors: readonly string[];
  readonly event_types: Readonly<Record<string, number>>;
  readonly sequence_range?: readonly [number, number];
  readonly first_timestamp?: string;
  readonly last_timestamp?: string;
  readonly duration_ms?: number;
  readonly manifest_event_count?: number;
  readonly manifest_last_sequence?: number;
}

interface ParsedCommand {
  readonly name: CommandName;
  readonly directory: string;
  readonly format: OutputFormat;
  readonly graphKind: GraphProjectionKind;
  readonly filter: GraphFilter;
  readonly foldNoise: boolean;
  readonly replayMode?: ReplayMode;
  readonly outputDirectory?: string;
  readonly inputFiles?: readonly string[];
  readonly configFile?: string;
  readonly dryRun?: boolean;
  readonly resume?: boolean;
}

class CliUsageError extends Error {
  readonly code = 'CLI_USAGE_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new CliUsageError(`${option} requires a value.`);
  }
  return value;
}

function parseSequence(value: string, option: string): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new CliUsageError(`${option} must be a non-negative integer.`);
  }
  return sequence;
}

function parseStatus(value: string): GraphNodeStatus {
  if (!graphStatuses.has(value as GraphNodeStatus)) {
    throw new CliUsageError(
      `Unknown status "${value}". Expected one of ${[...graphStatuses].join(', ')}.`,
    );
  }
  return value as GraphNodeStatus;
}

function parseGraphKind(value: string): GraphProjectionKind {
  if (!graphKinds.has(value as GraphProjectionKind)) {
    throw new CliUsageError(
      `Unknown graph kind "${value}". Expected one of ${[...graphKinds].join(', ')}.`,
    );
  }
  return value as GraphProjectionKind;
}

function parseFormat(value: string): OutputFormat {
  if (value !== 'text' && value !== 'json' && value !== 'mermaid') {
    throw new CliUsageError(`Unknown output format "${value}". Expected text, json, or mermaid.`);
  }
  return value;
}

function parseCommand(argv: readonly string[]): ParsedCommand {
  const commandValue = argv[0];
  if (commandValue === undefined || commandValue.startsWith('-')) {
    throw new CliUsageError('A command is required: validate, inspect, graph, replay, or view.');
  }
  if (
    commandValue !== 'validate' &&
    commandValue !== 'inspect' &&
    commandValue !== 'graph' &&
    commandValue !== 'replay' &&
    commandValue !== 'import-otel' &&
    commandValue !== 'export-otel' &&
    commandValue !== 'view'
  ) {
    throw new CliUsageError(`Unknown command "${commandValue}".`);
  }

  let directory: string | undefined;
  let format: OutputFormat = commandValue === 'graph' ? 'mermaid' : 'text';
  let graphKind: GraphProjectionKind = 'causal-dag';
  let actor: string | undefined;
  let type: string | undefined;
  let status: GraphNodeStatus | undefined;
  let minSequence: number | undefined;
  let maxSequence: number | undefined;
  let foldNoise = true;
  let replayMode: ReplayMode | undefined;
  let outputDirectory: string | undefined;
  let configFile: string | undefined;
  let dryRun = false;
  let resume = false;
  const inputFiles: string[] = [];

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === '--json') {
      format = 'json';
      continue;
    }
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (argument === '--resume') {
      resume = true;
      continue;
    }
    if (argument === '--config' || argument.startsWith('--config=')) {
      configFile = argument.startsWith('--config=')
        ? argument.slice('--config='.length)
        : readOptionValue(argv, index++, '--config');
      continue;
    }
    if (argument === '--mode' || argument.startsWith('--mode=')) {
      const value = argument.startsWith('--mode=')
        ? argument.slice('--mode='.length)
        : readOptionValue(argv, index++, '--mode');
      if (value !== 'mock') {
        throw new CliUsageError('Only --mode mock is currently available from the CLI.');
      }
      replayMode = value;
      continue;
    }
    if (argument === '--output' || argument.startsWith('--output=')) {
      outputDirectory = argument.startsWith('--output=')
        ? argument.slice('--output='.length)
        : readOptionValue(argv, index++, '--output');
      continue;
    }
    if (argument === '--no-fold-noise') {
      foldNoise = false;
      continue;
    }
    if (argument === '--fold-noise') {
      foldNoise = true;
      continue;
    }
    if (argument === '--format' || argument.startsWith('--format=')) {
      const value = argument.startsWith('--format=')
        ? argument.slice('--format='.length)
        : readOptionValue(argv, index++, '--format');
      format = parseFormat(value);
      continue;
    }
    if (argument === '--kind' || argument.startsWith('--kind=')) {
      const value = argument.startsWith('--kind=')
        ? argument.slice('--kind='.length)
        : readOptionValue(argv, index++, '--kind');
      graphKind = parseGraphKind(value);
      continue;
    }
    if (argument === '--actor' || argument.startsWith('--actor=')) {
      actor = argument.startsWith('--actor=')
        ? argument.slice('--actor='.length)
        : readOptionValue(argv, index++, '--actor');
      continue;
    }
    if (argument === '--type' || argument.startsWith('--type=')) {
      type = argument.startsWith('--type=')
        ? argument.slice('--type='.length)
        : readOptionValue(argv, index++, '--type');
      continue;
    }
    if (argument === '--status' || argument.startsWith('--status=')) {
      const value = argument.startsWith('--status=')
        ? argument.slice('--status='.length)
        : readOptionValue(argv, index++, '--status');
      status = parseStatus(value);
      continue;
    }
    if (argument === '--min-sequence' || argument.startsWith('--min-sequence=')) {
      const value = argument.startsWith('--min-sequence=')
        ? argument.slice('--min-sequence='.length)
        : readOptionValue(argv, index++, '--min-sequence');
      minSequence = parseSequence(value, '--min-sequence');
      continue;
    }
    if (argument === '--max-sequence' || argument.startsWith('--max-sequence=')) {
      const value = argument.startsWith('--max-sequence=')
        ? argument.slice('--max-sequence='.length)
        : readOptionValue(argv, index++, '--max-sequence');
      maxSequence = parseSequence(value, '--max-sequence');
      continue;
    }
    if (argument.startsWith('-')) {
      throw new CliUsageError(`Unknown option "${argument}".`);
    }
    if (commandValue === 'import-otel') {
      inputFiles.push(argument);
      continue;
    }
    if (directory !== undefined) {
      throw new CliUsageError('Only one snapshot directory may be supplied.');
    }
    directory = argument;
  }

  if (commandValue === 'import-otel' && inputFiles.length === 0) {
    throw new CliUsageError('import-otel requires at least one OTLP JSON file.');
  }
  if (commandValue === 'import-otel' && outputDirectory === undefined) {
    throw new CliUsageError('import-otel requires --output <snapshot-directory>.');
  }
  if (commandValue === 'export-otel') {
    if (configFile === undefined) {
      throw new CliUsageError('export-otel requires --config <export-config.json>.');
    }
    if (resume && directory !== undefined) {
      throw new CliUsageError('export-otel --resume does not accept a snapshot directory.');
    }
    if (!resume && directory === undefined) {
      throw new CliUsageError('export-otel requires a snapshot directory or --resume.');
    }
    if (resume && dryRun) {
      throw new CliUsageError('export-otel --resume cannot be combined with --dry-run.');
    }
  }
  if (commandValue !== 'import-otel' && commandValue !== 'export-otel' && directory === undefined) {
    throw new CliUsageError('A snapshot directory is required.');
  }
  if (commandValue === 'replay' && replayMode === undefined) {
    throw new CliUsageError('replay requires --mode mock.');
  }
  if (commandValue === 'replay' && outputDirectory === undefined) {
    throw new CliUsageError('replay requires --output <replay-directory>.');
  }
  if (commandValue !== 'graph' && (format === 'mermaid' || graphKind !== 'causal-dag')) {
    throw new CliUsageError('--format mermaid and --kind are only supported by graph.');
  }
  if (
    commandValue !== 'graph' &&
    (!foldNoise ||
      actor !== undefined ||
      type !== undefined ||
      status !== undefined ||
      minSequence !== undefined ||
      maxSequence !== undefined)
  ) {
    throw new CliUsageError('Graph filters and noise folding options are only supported by graph.');
  }
  if (
    commandValue === 'view' &&
    (format !== 'text' ||
      graphKind !== 'causal-dag' ||
      !foldNoise ||
      Object.keys({ actor, type, status, minSequence, maxSequence }).some(
        (key) =>
          ({ actor, type, status, minSequence, maxSequence })[
            key as 'actor' | 'type' | 'status' | 'minSequence' | 'maxSequence'
          ] !== undefined,
      ))
  ) {
    throw new CliUsageError('Viewer does not accept output or graph filter options.');
  }
  if (
    commandValue !== 'replay' &&
    commandValue !== 'import-otel' &&
    (replayMode !== undefined || outputDirectory !== undefined)
  ) {
    throw new CliUsageError('--mode and --output are only supported by replay or import-otel.');
  }
  if (commandValue !== 'export-otel' && (configFile !== undefined || dryRun || resume)) {
    throw new CliUsageError('--config, --dry-run, and --resume are only supported by export-otel.');
  }
  if (minSequence !== undefined && maxSequence !== undefined && minSequence > maxSequence) {
    throw new CliUsageError('--min-sequence cannot be greater than --max-sequence.');
  }

  return {
    name: commandValue,
    directory: resolve(commandValue === 'import-otel' ? outputDirectory! : (directory ?? '.')),
    format,
    graphKind,
    filter: {
      ...(actor === undefined ? {} : { actor }),
      ...(type === undefined ? {} : { type }),
      ...(status === undefined ? {} : { status }),
      ...(minSequence === undefined ? {} : { minSequence }),
      ...(maxSequence === undefined ? {} : { maxSequence }),
    },
    foldNoise,
    ...(replayMode === undefined ? {} : { replayMode }),
    ...(outputDirectory === undefined ? {} : { outputDirectory: resolve(outputDirectory) }),
    ...(inputFiles.length === 0 ? {} : { inputFiles: inputFiles.map((file) => resolve(file)) }),
    ...(configFile === undefined ? {} : { configFile: resolve(configFile) }),
    ...(dryRun ? { dryRun: true } : {}),
    ...(resume ? { resume: true } : {}),
  };
}

function asString(value: unknown, name: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliUsageError(`Export config ${name} must be a non-empty string.`);
  }
  return value;
}

function asOptionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new CliUsageError(`Export config ${name} must be a non-negative number.`);
  }
  return Math.floor(value);
}

function parseExportConfig(value: unknown): OtelExportConfig {
  if (!isRecord(value)) throw new CliUsageError('Export config must be a JSON object.');
  const headersValue = value.headersEnv;
  let headersEnv: Record<string, string> | undefined;
  if (headersValue !== undefined) {
    if (!isRecord(headersValue))
      throw new CliUsageError('Export config headersEnv must be an object.');
    headersEnv = {};
    for (const [header, environment] of Object.entries(headersValue)) {
      if (typeof environment !== 'string' || environment.trim() === '') {
        throw new CliUsageError(
          `Export config headersEnv.${header} must name an environment variable.`,
        );
      }
      headersEnv[header] = environment;
    }
  }
  const contentPolicy = value.contentPolicy;
  if (
    contentPolicy !== undefined &&
    contentPolicy !== 'metadata-only' &&
    contentPolicy !== 'redacted-content'
  ) {
    throw new CliUsageError(
      'Export config contentPolicy must be metadata-only or redacted-content.',
    );
  }
  const endpoint = asString(value.endpoint, 'endpoint', false);
  const endpointEnv = asString(value.endpointEnv, 'endpointEnv', false);
  const queueDir = asString(value.queueDir, 'queueDir', false);
  const timeoutMs = asOptionalNumber(value.timeoutMs, 'timeoutMs');
  const batchSpanLimit = asOptionalNumber(value.batchSpanLimit, 'batchSpanLimit');
  const retryMaxAttempts = asOptionalNumber(value.retryMaxAttempts, 'retryMaxAttempts');
  const retryBudgetMs = asOptionalNumber(value.retryBudgetMs, 'retryBudgetMs');
  const queueMaxEntries = asOptionalNumber(value.queueMaxEntries, 'queueMaxEntries');
  const queueMaxBytes = asOptionalNumber(value.queueMaxBytes, 'queueMaxBytes');
  const queueRetentionMs = asOptionalNumber(value.queueRetentionMs, 'queueRetentionMs');
  const config: OtelExportConfig = {
    targetAlias: asString(value.targetAlias, 'targetAlias')!,
    serviceName: asString(value.serviceName, 'serviceName')!,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(endpointEnv === undefined ? {} : { endpointEnv }),
    ...(headersEnv === undefined ? {} : { headersEnv }),
    ...(contentPolicy === undefined ? {} : { contentPolicy }),
    ...(queueDir === undefined ? {} : { queueDir: resolve(queueDir) }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(batchSpanLimit === undefined ? {} : { batchSpanLimit }),
    ...(retryMaxAttempts === undefined ? {} : { retryMaxAttempts }),
    ...(retryBudgetMs === undefined ? {} : { retryBudgetMs }),
    ...(queueMaxEntries === undefined ? {} : { queueMaxEntries }),
    ...(queueMaxBytes === undefined ? {} : { queueMaxBytes }),
    ...(queueRetentionMs === undefined ? {} : { queueRetentionMs }),
  };
  if (!isExportEndpointConfigured(config)) {
    throw new CliUsageError('Export config must specify exactly one of endpoint or endpointEnv.');
  }
  if (config.batchSpanLimit !== undefined && config.batchSpanLimit < 1) {
    throw new CliUsageError('Export config batchSpanLimit must be at least 1.');
  }
  return config;
}

async function loadExportConfig(path: string): Promise<OtelExportConfig> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    throw new CliUsageError(`Could not read export config "${path}": ${detail}`);
  }
  return parseExportConfig(value);
}

function normalizeFile(root: string, file: string | undefined): string | undefined {
  if (file === undefined) {
    return undefined;
  }
  const relativeFile = relative(root, file);
  if (relativeFile !== '' && !relativeFile.startsWith('..') && !relativeFile.includes(':')) {
    return relativeFile.replaceAll('\\', '/');
  }
  return basename(file);
}

function normalizeDiagnostic(
  root: string,
  diagnostic: ValidationDiagnostic | TraceDiagnostic,
): CliDiagnostic {
  const file = normalizeFile(root, diagnostic.file);
  return {
    severity: diagnostic.severity,
    code: diagnostic.code,
    path: diagnostic.path,
    message: diagnostic.message,
    source: diagnostic.source,
    ...(file === undefined ? {} : { file }),
    ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
  };
}

function mergeDiagnostics(
  root: string,
  ...diagnosticLists: readonly (readonly (ValidationDiagnostic | TraceDiagnostic)[])[]
): CliDiagnostic[] {
  const diagnostics: CliDiagnostic[] = [];
  const seen = new Set<string>();
  diagnosticLists.flat().forEach((diagnostic) => {
    const normalized = normalizeDiagnostic(root, diagnostic);
    const key = [normalized.severity, normalized.code, normalized.path, normalized.line ?? ''].join(
      '\u0000',
    );
    if (!seen.has(key)) {
      seen.add(key);
      diagnostics.push(normalized);
    }
  });
  return diagnostics;
}

function writeJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function diagnosticLabel(diagnostic: CliDiagnostic): string {
  const location =
    diagnostic.file === undefined
      ? diagnostic.path
      : `${diagnostic.file}${diagnostic.line === undefined ? '' : `:${diagnostic.line}`} ${diagnostic.path}`;
  return `${diagnostic.severity.toUpperCase()} [${diagnostic.code}] ${location}: ${diagnostic.message}`;
}

function writeDiagnosticsText(io: CliIo, diagnostics: readonly CliDiagnostic[]): void {
  if (diagnostics.length === 0) {
    io.stdout('Diagnostics: none\n');
    return;
  }
  io.stdout(`Diagnostics (${String(diagnostics.length)}):\n`);
  diagnostics.forEach((diagnostic) => io.stdout(`- ${diagnosticLabel(diagnostic)}\n`));
}

function writeInspectText(
  io: CliIo,
  directory: string,
  snapshot: TraceSnapshot,
  summary: InspectSummary,
  errors: readonly InspectError[],
): void {
  io.stdout(`Snapshot: ${directory}\n`);
  io.stdout(`Run: ${summary.run_id ?? 'unknown'}\n`);
  io.stdout(
    `Status: ${summary.terminal_status ?? 'unknown'} (${summary.run_state ?? 'unknown'})\n`,
  );
  if (summary.runtime !== undefined) {
    io.stdout(`Runtime: ${summary.runtime.name}@${summary.runtime.version}\n`);
  }
  io.stdout(
    `Source: ${summary.source ?? 'unknown'}; completeness: ${summary.completeness ?? 'unknown'}; execution: ${summary.execution_eligibility ?? 'unknown'}\n`,
  );
  if ((summary.limitations?.length ?? 0) > 0) {
    io.stdout(
      `Limitations: ${summary.limitations!.map((limitation) => limitation.code).join(', ')}\n`,
    );
  }
  io.stdout(`Events: ${String(summary.event_count)}\n`);
  io.stdout(`Checkpoints: ${String(summary.checkpoint_count)}\n`);
  io.stdout(
    `Artifacts: ${String(summary.artifact_count)} (${String(summary.artifact_reference_count)} references)\n`,
  );
  io.stdout(`Model calls: ${String(summary.model_call_count)}\n`);
  io.stdout(`Tool calls: ${String(summary.tool_call_count)}\n`);
  io.stdout(`Failures: ${String(summary.failure_count)}\n`);
  io.stdout(
    `Duration: ${summary.duration_ms === undefined ? 'unknown' : `${String(summary.duration_ms)} ms`}\n`,
  );
  io.stdout(`Actors: ${summary.actors.length === 0 ? 'none' : summary.actors.join(', ')}\n`);
  if (errors.length > 0) {
    io.stdout('Errors:\n');
    errors.forEach((error) => {
      const retryable = error.retryable === true ? ', retryable' : '';
      io.stdout(
        `- ${error.type} ${error.code} at sequence ${String(error.sequence)}${retryable}\n`,
      );
    });
  }
  writeDiagnosticsText(
    io,
    snapshot.diagnostics.map((diagnostic) => normalizeDiagnostic(directory, diagnostic)),
  );
}

function eventError(event: TraceSnapshot['events'][number]): InspectError | undefined {
  if (!event.type.endsWith('.failed') && event.type !== 'run.failed') {
    return undefined;
  }
  if (!isRecord(event.payload) || !isRecord(event.payload.error)) {
    return {
      event_id: event.event_id,
      type: event.type,
      sequence: event.sequence,
      code: 'UNKNOWN_ERROR',
    };
  }
  const error = event.payload.error;
  const code = typeof error.code === 'string' ? error.code : 'UNKNOWN_ERROR';
  return {
    event_id: event.event_id,
    type: event.type,
    sequence: event.sequence,
    code,
    ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
    ...(typeof error.kind === 'string' ? { kind: error.kind } : {}),
  };
}

export function createInspectSummary(snapshot: TraceSnapshot): InspectSummary {
  const eventTypes = new Map<string, number>();
  const actors = new Set<string>();
  let modelCallCount = 0;
  let toolCallCount = 0;
  let failureCount = 0;

  snapshot.events.forEach((event) => {
    eventTypes.set(event.type, (eventTypes.get(event.type) ?? 0) + 1);
    actors.add(event.actor);
    if (event.type === 'model.requested') {
      modelCallCount += 1;
    }
    if (event.type === 'tool.requested') {
      toolCallCount += 1;
    }
    if (event.type.endsWith('.failed') || event.type === 'run.failed') {
      failureCount += 1;
    }
  });

  const sortedTypes = Object.fromEntries(
    [...eventTypes.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  const first = snapshot.events[0];
  const last = snapshot.events.at(-1);
  const artifactReferenceCount = [...snapshot.artifactReferences.values()].reduce(
    (count, references) => count + references.length,
    0,
  );
  const runtime = snapshot.manifest?.runtime;
  const observation = readSnapshotObservationMetadata(snapshot.manifest);
  const eligibility = assessSnapshotExecution(observation);

  return {
    ...(snapshot.manifest?.run_id === undefined ? {} : { run_id: snapshot.manifest.run_id }),
    ...(snapshot.manifest?.run_state === undefined
      ? {}
      : { run_state: snapshot.manifest.run_state }),
    ...(snapshot.manifest === undefined
      ? {}
      : { terminal_status: snapshot.manifest.terminal_status }),
    ...(runtime === undefined ? {} : { runtime }),
    source: observation.source,
    completeness: observation.completeness,
    limitations: observation.limitations,
    execution_eligibility: eligibility.eligibility,
    event_count: snapshot.events.length,
    checkpoint_count: snapshot.checkpoints.length,
    artifact_count: snapshot.artifacts.size,
    artifact_reference_count: artifactReferenceCount,
    model_call_count: modelCallCount,
    tool_call_count: toolCallCount,
    failure_count: failureCount,
    actor_count: actors.size,
    actors: [...actors].sort((left, right) => left.localeCompare(right)),
    event_types: sortedTypes,
    ...(first === undefined || last === undefined
      ? {}
      : {
          sequence_range: [first.sequence, last.sequence] as const,
          first_timestamp: first.timestamp,
          last_timestamp: last.timestamp,
          duration_ms: Math.max(0, last.monotonic_offset_ms - first.monotonic_offset_ms),
        }),
    ...(snapshot.manifest?.event_count === undefined
      ? {}
      : { manifest_event_count: snapshot.manifest.event_count }),
    ...(snapshot.manifest?.last_sequence === undefined
      ? {}
      : { manifest_last_sequence: snapshot.manifest.last_sequence }),
  };
}

export function graphToMermaid(projection: GraphProjection): string {
  const mermaidIds = new Map(
    projection.nodes.map((node, index) => [node.id, `node_${String(index + 1)}`]),
  );
  const lines = ['flowchart TD'];
  projection.nodes.forEach((node) => {
    const mermaidId = mermaidIds.get(node.id);
    if (mermaidId === undefined) {
      return;
    }
    const sourceIds = node.eventIds.join(', ');
    const label = `${node.label} [${sourceIds}]`;
    const escapedLabel = label
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('\r', ' ')
      .replaceAll('\n', ' ');
    lines.push(`  ${mermaidId}["${escapedLabel}"]`);
  });
  projection.edges.forEach((edge) => {
    const from = mermaidIds.get(edge.from);
    const to = mermaidIds.get(edge.to);
    if (from !== undefined && to !== undefined) {
      lines.push(`  ${from} -->|${edge.kind}| ${to}`);
    }
  });
  return `${lines.join('\n')}\n`;
}

function inspectErrors(snapshot: TraceSnapshot): InspectError[] {
  return snapshot.events
    .map(eventError)
    .filter((error): error is InspectError => error !== undefined);
}

function snapshotJsonDiagnostics(directory: string, snapshot: TraceSnapshot): CliDiagnostic[] {
  return snapshot.diagnostics.map((diagnostic) => normalizeDiagnostic(directory, diagnostic));
}

async function loadValidation(directory: string): Promise<{
  readonly valid: boolean;
  readonly diagnostics: readonly CliDiagnostic[];
}> {
  const [validation, snapshot] = await Promise.all([
    validateSnapshotDirectory(directory),
    loadTraceSnapshot(directory),
  ]);
  const diagnostics = mergeDiagnostics(directory, validation.diagnostics, snapshot.diagnostics);
  return {
    valid:
      validation.valid &&
      snapshot.valid &&
      diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    diagnostics,
  };
}

const maxOtlpInputFileBytes = 64 * 1024 * 1024;

const importAttributePrefixes = [
  '/attributes',
  '/resource/attributes',
  '/scope/attributes',
  '/events/*/attributes',
  '/links/*/attributes',
] as const;

const importSensitiveAttributeNames = [
  'authorization',
  'Authorization',
  'api_key',
  'apiKey',
  'password',
  'secret',
  'token',
] as const;

const importRedactionRules: readonly FieldRedactionRule[] = importAttributePrefixes.flatMap(
  (prefix) =>
    importSensitiveAttributeNames.map((name) => ({
      path: `${prefix}/${name}`,
      category: name.toLowerCase() === 'authorization' ? 'authorization' : 'secret',
      strategy: 'reference' as const,
    })),
);

interface ImportedSnapshotReport {
  readonly directory: string;
  readonly source_trace_id: string;
  readonly imported_span_count: number;
  readonly completeness: string;
  readonly limitations: readonly { readonly code: string; readonly message: string }[];
}

interface ImportOtelCliResult {
  readonly snapshots: readonly ImportedSnapshotReport[];
  readonly imported_span_count: number;
  readonly rejected_span_count: number;
  readonly duplicate_span_count: number;
  readonly truncated_value_count: number;
  readonly diagnostics: readonly unknown[];
}

async function readOtlpInputFiles(inputFiles: readonly string[]): Promise<unknown> {
  const resourceSpans: unknown[] = [];
  for (const inputFile of inputFiles) {
    const metadata = await stat(inputFile);
    if (!metadata.isFile()) {
      throw new Error(`OTLP input "${inputFile}" is not a regular file.`);
    }
    if (metadata.size > maxOtlpInputFileBytes) {
      throw new Error(
        `OTLP input "${inputFile}" exceeds the ${String(maxOtlpInputFileBytes)} byte limit.`,
      );
    }
    let document: unknown;
    try {
      document = JSON.parse(await readFile(inputFile, 'utf8')) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown JSON parsing error.';
      throw new Error(`Could not parse OTLP JSON input "${inputFile}": ${message}`);
    }
    if (!isRecord(document) || !Array.isArray(document.resourceSpans)) {
      throw new Error(
        `OTLP input "${inputFile}" must be an ExportTraceServiceRequest with resourceSpans.`,
      );
    }
    resourceSpans.push(...document.resourceSpans);
  }
  return { resourceSpans };
}

async function importOtlpFiles(
  inputFiles: readonly string[],
  outputDirectory: string,
): Promise<ImportOtelCliResult> {
  const source = await readOtlpInputFiles(inputFiles);
  const imported = importOtlpTraces(source, { profile: 'otel-genai-1.0' });
  if (imported.traces.length === 0) {
    return {
      snapshots: [],
      imported_span_count: imported.report.importedSpanCount,
      rejected_span_count: imported.report.rejectedSpanCount,
      duplicate_span_count: imported.report.duplicateSpanCount,
      truncated_value_count: imported.report.truncatedValueCount,
      diagnostics: imported.report.diagnostics,
    };
  }

  await mkdir(outputDirectory, { recursive: true });
  const pipeline = createDefaultRedactionPipeline({ fieldRules: importRedactionRules });
  const snapshots: ImportedSnapshotReport[] = [];
  for (const trace of imported.traces) {
    const snapshot = toObservationSnapshot(trace);
    const directory = join(outputDirectory, snapshot.manifest.run_id);
    try {
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(
          `Refusing to overwrite existing imported snapshot directory "${directory}".`,
        );
      }
      throw error;
    }
    const writer = await SnapshotWriter.open(directory, { flushMode: 'event' });
    try {
      for (const event of snapshot.events) {
        await writer.append(await pipeline.redactEvent(event));
      }
      await writer.commit(snapshot.manifest);
    } finally {
      await writer.close();
    }
    const validation = await validateSnapshotDirectory(directory);
    if (!validation.valid) {
      throw new Error(`Imported snapshot "${directory}" failed validation after persistence.`);
    }
    snapshots.push({
      directory,
      source_trace_id: trace.traceId,
      imported_span_count: trace.spans.length,
      completeness: trace.completeness,
      limitations: trace.limitations,
    });
  }
  return {
    snapshots,
    imported_span_count: imported.report.importedSpanCount,
    rejected_span_count: imported.report.rejectedSpanCount,
    duplicate_span_count: imported.report.duplicateSpanCount,
    truncated_value_count: imported.report.truncatedValueCount,
    diagnostics: imported.report.diagnostics,
  };
}

function usage(command?: CommandName): string {
  if (command === 'validate') {
    return [
      'Usage: alsnap validate <snapshot-directory> [--json]',
      '',
      'Validate manifest, events, checkpoints, artifact references, and structure.',
    ].join('\n');
  }
  if (command === 'inspect') {
    return [
      'Usage: alsnap inspect <snapshot-directory> [--json]',
      '',
      'Print a metadata-only run summary, errors, and diagnostics.',
    ].join('\n');
  }
  if (command === 'graph') {
    return [
      'Usage: alsnap graph <snapshot-directory> [options]',
      '',
      'Options:',
      '  --kind <causal-dag|call-tree|timeline>  Projection kind (default: causal-dag)',
      '  --format <mermaid|json|text>            Output format (default: mermaid)',
      '  --actor <name>                          Filter by actor',
      '  --type <event-type>                     Filter by event type',
      '  --status <status>                       Filter by node status',
      '  --min-sequence <n>                      Inclusive sequence lower bound',
      '  --max-sequence <n>                      Inclusive sequence upper bound',
      '  --no-fold-noise                         Keep adjacent stream/noise events separate',
      '  --json                                  Alias for --format json',
    ].join('\n');
  }
  if (command === 'replay') {
    return [
      'Usage: alsnap replay <snapshot-directory> --mode mock --output <replay-directory> [--json]',
      '',
      'Create a new snapshot by replaying saved model and tool results.',
      'Verified replay requires explicitly configured live adapters through the SDK.',
    ].join('\n');
  }
  if (command === 'import-otel') {
    return [
      'Usage: alsnap import-otel <otlp-json-file> [more-otlp-json-files...] --output <snapshot-directory> [--json]',
      '',
      'Import OTLP/HTTP JSON traces as redacted, observation-only snapshots.',
      'Each source trace creates one new snapshot directory; existing snapshots are never overwritten.',
    ].join('\n');
  }
  if (command === 'export-otel') {
    return [
      'Usage: alsnap export-otel <snapshot-directory> --config <export-config.json> [--dry-run] [--json]',
      '       alsnap export-otel --resume --config <export-config.json> [--json]',
      '',
      'Map a local snapshot to filtered OTLP/HTTP JSON and send it through the configured persistent queue.',
      'Dry-run never resolves credentials, contacts the network, or writes a queue entry.',
    ].join('\n');
  }
  if (command === 'view') {
    return [
      'Usage: alsnap view <snapshot-directory>',
      '',
      'Start a read-only local Viewer on 127.0.0.1 for the explicitly selected snapshot.',
      'The command prints a session-token URL and remains running until interrupted.',
    ].join('\n');
  }
  return [
    'Agent Loop Snapshot CLI',
    '',
    'Usage: alsnap <command> <snapshot-directory> [options]',
    '',
    'Commands:',
    '  validate  Validate a snapshot and report diagnostics',
    '  inspect   Print a metadata-only run summary',
    '  graph     Export a causal DAG, call tree, or timeline',
    '  replay    Create a mock replay snapshot from recorded results',
    '  import-otel  Import OTLP JSON as observation-only snapshots',
    '  export-otel  Export a snapshot or resume its configured OTLP queue',
    '  view      Start the read-only local Snapshot Viewer',
    '',
    'Global options: --help, --version, --json',
  ].join('\n');
}

function defaultIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  io: CliIo = defaultIo(),
): Promise<number> {
  const commandValue = argv[0];
  if (commandValue === '--help' || commandValue === '-h' || argv.includes('--help')) {
    const command =
      commandValue === 'validate' ||
      commandValue === 'inspect' ||
      commandValue === 'graph' ||
      commandValue === 'replay' ||
      commandValue === 'import-otel' ||
      commandValue === 'export-otel' ||
      commandValue === 'view'
        ? commandValue
        : undefined;
    io.stdout(`${usage(command)}\n`);
    return cliExitCodes.success;
  }
  if (commandValue === '--version' || commandValue === '-V') {
    io.stdout(`${cliVersion}\n`);
    return cliExitCodes.success;
  }

  let command: ParsedCommand;
  try {
    command = parseCommand(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid CLI arguments.';
    if (argv.includes('--json')) {
      writeJson(io, { command: commandValue ?? null, error: { code: 'CLI_USAGE_ERROR', message } });
    } else {
      io.stderr(`Error: ${message}\n\n${usage()}\n`);
    }
    return cliExitCodes.runtimeError;
  }

  try {
    if (command.name === 'view') {
      const viewer = await startViewer({ snapshotDirectory: command.directory });
      io.stdout(`Viewer (read-only, loopback only): ${viewer.url}\nPress Ctrl+C to stop.\n`);
      return cliExitCodes.success;
    }
    if (command.name === 'validate') {
      const result = await loadValidation(command.directory);
      if (command.format === 'json') {
        writeJson(io, {
          command: command.name,
          directory: command.directory,
          valid: result.valid,
          diagnostics: result.diagnostics,
        });
      } else {
        io.stdout(`${result.valid ? 'VALID' : 'INVALID'}\n`);
        io.stdout(`Snapshot: ${command.directory}\n`);
        writeDiagnosticsText(io, result.diagnostics);
      }
      return result.valid ? cliExitCodes.success : cliExitCodes.validationFailed;
    }

    if (command.name === 'import-otel') {
      const inputFiles = command.inputFiles;
      const outputDirectory = command.outputDirectory;
      if (inputFiles === undefined || outputDirectory === undefined) {
        throw new CliUsageError(
          'import-otel requires at least one input file and --output <snapshot-directory>.',
        );
      }
      const result = await importOtlpFiles(inputFiles, outputDirectory);
      const valid = result.snapshots.length > 0;
      if (command.format === 'json') {
        writeJson(io, {
          command: command.name,
          valid,
          output_directory: outputDirectory,
          input_files: inputFiles,
          snapshots: result.snapshots,
          report: {
            imported_span_count: result.imported_span_count,
            rejected_span_count: result.rejected_span_count,
            duplicate_span_count: result.duplicate_span_count,
            truncated_value_count: result.truncated_value_count,
            diagnostics: result.diagnostics,
          },
        });
      } else {
        io.stdout(`${valid ? 'IMPORTED' : 'NO_VALID_TRACES'}\n`);
        io.stdout(`Output: ${outputDirectory}\n`);
        result.snapshots.forEach((snapshot) => {
          io.stdout(
            `- ${snapshot.source_trace_id}: ${snapshot.directory} (${String(snapshot.imported_span_count)} spans, ${snapshot.completeness})\n`,
          );
        });
        io.stdout(
          `Report: ${String(result.imported_span_count)} imported, ${String(result.rejected_span_count)} rejected, ${String(result.duplicate_span_count)} deduplicated\n`,
        );
      }
      return valid ? cliExitCodes.success : cliExitCodes.validationFailed;
    }

    if (command.name === 'export-otel') {
      const configFile = command.configFile;
      if (configFile === undefined) {
        throw new CliUsageError('export-otel requires --config <export-config.json>.');
      }
      const config = await loadExportConfig(configFile);
      if (command.resume) {
        if (config.queueDir === undefined) {
          throw new CliUsageError('export-otel --resume requires queueDir in the export config.');
        }
        const exporter = createOtlpExporter(config);
        const resumed = await exporter.resume();
        const flush = await exporter.flush();
        const valid =
          resumed.some((delivery) => delivery.batches.length > 0) &&
          !flush.deadlineExceeded &&
          flush.pendingCount === 0 &&
          flush.deliveries.length > 0 &&
          flush.deliveries.every(acceptedDelivery);
        if (command.format === 'json') {
          writeJson(io, {
            command: command.name,
            resumed: true,
            deliveries: resumed,
            target_alias: config.targetAlias,
            valid,
            flush,
          });
        } else {
          io.stdout(`${valid ? 'EXPORTED' : 'EXPORT_INCOMPLETE'}\n`);
          io.stdout(`Target: ${config.targetAlias}\n`);
          io.stdout(`Pending: ${String(flush.pendingCount)}\n`);
        }
        return valid ? cliExitCodes.success : cliExitCodes.runtimeError;
      }

      const snapshot = await loadTraceSnapshot(command.directory);
      if (!snapshot.valid || snapshot.manifest === undefined) {
        const diagnostics = snapshotJsonDiagnostics(command.directory, snapshot);
        if (command.format === 'json') {
          writeJson(io, {
            command: command.name,
            directory: command.directory,
            valid: false,
            diagnostics,
          });
        } else {
          io.stdout('INVALID\n');
          writeDiagnosticsText(io, diagnostics);
        }
        return cliExitCodes.validationFailed;
      }
      const exportInput = { manifest: snapshot.manifest, events: snapshot.events };
      const dryRun = dryRunOtlpExport(exportInput, {
        ...(config.contentPolicy === undefined ? {} : { contentPolicy: config.contentPolicy }),
        serviceName: config.serviceName,
        targetAlias: config.targetAlias,
      });
      if (command.dryRun) {
        const valid = dryRun.mapping.report.spanCount > 0;
        if (command.format === 'json') {
          writeJson(io, {
            command: command.name,
            directory: command.directory,
            dry_run: true,
            target_alias: config.targetAlias,
            delivery: dryRun.delivery,
            mapping: dryRun.mapping.report,
            valid,
            ...(valid
              ? {}
              : {
                  diagnostics: [
                    {
                      code: 'NO_DATA',
                      message: 'The source snapshot produced no exportable OTLP spans.',
                    },
                  ],
                }),
          });
        } else {
          io.stdout(`${valid ? 'DRY_RUN' : 'NO_DATA'}\n`);
          io.stdout(`Target: ${config.targetAlias}\n`);
          io.stdout(`Spans: ${String(dryRun.mapping.report.spanCount)}\n`);
          io.stdout(`Dropped fields: ${String(dryRun.mapping.report.droppedFieldCount)}\n`);
        }
        return valid ? cliExitCodes.success : cliExitCodes.runtimeError;
      }
      if (config.queueDir === undefined) {
        throw new CliUsageError('export-otel requires queueDir in the export config.');
      }
      const exporter = createOtlpExporter(config);
      const queued = await exporter.exportSnapshot(exportInput);
      const flush = await exporter.flush();
      const valid =
        queued.batches.length > 0 &&
        queued.state !== 'not_sent' &&
        !flush.deadlineExceeded &&
        flush.pendingCount === 0 &&
        flush.deliveries.length > 0 &&
        flush.deliveries.every(acceptedDelivery);
      if (command.format === 'json') {
        writeJson(io, {
          command: command.name,
          directory: command.directory,
          target_alias: config.targetAlias,
          valid,
          queued,
          flush,
          mapping: dryRun.mapping.report,
        });
      } else {
        io.stdout(`${valid ? 'EXPORTED' : 'EXPORT_INCOMPLETE'}\n`);
        io.stdout(`Target: ${config.targetAlias}\n`);
        io.stdout(`Pending: ${String(flush.pendingCount)}\n`);
      }
      return valid ? cliExitCodes.success : cliExitCodes.runtimeError;
    }

    const snapshot = await loadTraceSnapshot(command.directory);
    if (command.name === 'replay') {
      const outputDirectory = command.outputDirectory;
      if (outputDirectory === undefined || command.replayMode !== 'mock') {
        throw new CliUsageError('replay requires --mode mock and --output <replay-directory>.');
      }
      if (outputDirectory === command.directory) {
        throw new CliUsageError(
          'The replay output directory must differ from the source snapshot.',
        );
      }
      if (existsSync(outputDirectory)) {
        throw new CliUsageError('The replay output directory must not already exist.');
      }
      if (!snapshot.valid) {
        const diagnostics = snapshotJsonDiagnostics(command.directory, snapshot);
        if (command.format === 'json') {
          writeJson(io, {
            command: command.name,
            directory: command.directory,
            valid: false,
            diagnostics,
          });
        } else {
          io.stdout('INVALID\n');
          writeDiagnosticsText(io, diagnostics);
        }
        return cliExitCodes.validationFailed;
      }
      const eligibility = assessSnapshotExecution(
        readSnapshotObservationMetadata(snapshot.manifest),
      );
      if (eligibility.eligibility === 'observation_only') {
        const diagnostic = {
          severity: 'error' as const,
          code: 'SOURCE_TRACE_OBSERVATION_ONLY',
          path: '/manifest',
          message: `Replay is blocked: ${eligibility.reason}`,
          source: 'manifest',
        };
        if (command.format === 'json') {
          writeJson(io, {
            command: command.name,
            directory: command.directory,
            valid: false,
            diagnostics: [diagnostic],
          });
        } else {
          io.stdout('OBSERVATION_ONLY\n');
          writeDiagnosticsText(io, [diagnostic]);
        }
        return cliExitCodes.validationFailed;
      }

      const writer = await SnapshotWriter.open(outputDirectory, { flushMode: 'event' });
      try {
        const recorder = new Recorder({ interceptors: [writer.asInterceptor()] });
        const result = await new MockReplayRunner({ source: snapshot, recorder }).run();
        await writer.commit(result.manifest);
        const validation = await validateSnapshotDirectory(outputDirectory);
        const valid =
          result.manifest.terminal_status === 'completed' &&
          validation.valid &&
          result.diagnostics.length === 0;
        if (command.format === 'json') {
          writeJson(io, {
            command: command.name,
            valid,
            terminal_status: result.manifest.terminal_status,
            output_directory: outputDirectory,
          });
        } else {
          io.stdout(`${valid ? 'REPLAYED' : 'REPLAY_FAILED'}\n`);
          io.stdout(`Snapshot: ${outputDirectory}\n`);
          io.stdout(`Status: ${result.manifest.terminal_status}\n`);
        }
        return valid ? cliExitCodes.success : cliExitCodes.runtimeError;
      } finally {
        await writer.close();
      }
    }
    if (command.name === 'inspect') {
      const summary = createInspectSummary(snapshot);
      const errors = inspectErrors(snapshot);
      const diagnostics = snapshotJsonDiagnostics(command.directory, snapshot);
      if (command.format === 'json') {
        writeJson(io, {
          command: command.name,
          directory: command.directory,
          valid: snapshot.valid,
          summary,
          errors,
          diagnostics,
        });
      } else {
        writeInspectText(io, command.directory, snapshot, summary, errors);
      }
      return snapshot.valid ? cliExitCodes.success : cliExitCodes.validationFailed;
    }

    const projection = projectGraph(snapshot, command.graphKind, {
      filter: command.filter,
      foldNoise: command.foldNoise,
    });
    const diagnostics = snapshotJsonDiagnostics(command.directory, snapshot);
    const observation = readSnapshotObservationMetadata(snapshot.manifest);
    const eligibility = assessSnapshotExecution(observation);
    if (command.format === 'json') {
      writeJson(io, {
        command: command.name,
        directory: command.directory,
        valid: snapshot.valid,
        projection: command.graphKind,
        graph: projection,
        observation: {
          source: observation.source,
          completeness: observation.completeness,
          limitations: observation.limitations,
          execution_eligibility: eligibility.eligibility,
        },
        diagnostics,
      });
    } else if (command.format === 'text') {
      io.stdout(`Graph: ${command.graphKind}\n`);
      io.stdout(`Nodes: ${String(projection.nodes.length)}\n`);
      io.stdout(`Edges: ${String(projection.edges.length)}\n`);
      io.stdout(
        `Source: ${observation.source}; completeness: ${observation.completeness}; execution: ${eligibility.eligibility}\n`,
      );
      projection.nodes.forEach((node) => {
        io.stdout(`- ${node.label} [${node.eventIds.join(', ')}]\n`);
      });
      writeDiagnosticsText(io, diagnostics);
    } else {
      io.stdout(graphToMermaid(projection));
      if (diagnostics.length > 0) {
        io.stderr(`Diagnostics: ${String(diagnostics.length)} (use --format json for details)\n`);
      }
    }
    return snapshot.valid ? cliExitCodes.success : cliExitCodes.validationFailed;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CLI command failed.';
    if (command.format === 'json') {
      writeJson(io, {
        command: command.name,
        directory: command.directory,
        error: { code: 'CLI_RUNTIME_ERROR', message },
      });
    } else {
      io.stderr(`Error: ${message}\n`);
    }
    return cliExitCodes.runtimeError;
  }
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  realpathSync(resolve(entryPath)) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = await runCli();
}
