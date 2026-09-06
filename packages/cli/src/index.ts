#!/usr/bin/env node

import { basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
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

export const cliPackageName = '@agent-loop-snapshot/cli' as const;
export const cliVersion = '0.1.0' as const;

export const cliExitCodes = {
  success: 0,
  runtimeError: 1,
  validationFailed: 2,
} as const;

type CommandName = 'validate' | 'inspect' | 'graph';
type OutputFormat = 'text' | 'json' | 'mermaid';

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
    throw new CliUsageError('A command is required: validate, inspect, or graph.');
  }
  if (commandValue !== 'validate' && commandValue !== 'inspect' && commandValue !== 'graph') {
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

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === '--json') {
      format = 'json';
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
    if (directory !== undefined) {
      throw new CliUsageError('Only one snapshot directory may be supplied.');
    }
    directory = argument;
  }

  if (directory === undefined) {
    throw new CliUsageError('A snapshot directory is required.');
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
  if (minSequence !== undefined && maxSequence !== undefined && minSequence > maxSequence) {
    throw new CliUsageError('--min-sequence cannot be greater than --max-sequence.');
  }

  return {
    name: commandValue,
    directory: resolve(directory),
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
  };
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

  return {
    ...(snapshot.manifest?.run_id === undefined ? {} : { run_id: snapshot.manifest.run_id }),
    ...(snapshot.manifest?.run_state === undefined
      ? {}
      : { run_state: snapshot.manifest.run_state }),
    ...(snapshot.manifest === undefined
      ? {}
      : { terminal_status: snapshot.manifest.terminal_status }),
    ...(runtime === undefined ? {} : { runtime }),
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
  return [
    'Agent Loop Snapshot CLI',
    '',
    'Usage: alsnap <command> <snapshot-directory> [options]',
    '',
    'Commands:',
    '  validate  Validate a snapshot and report diagnostics',
    '  inspect   Print a metadata-only run summary',
    '  graph     Export a causal DAG, call tree, or timeline',
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
      commandValue === 'validate' || commandValue === 'inspect' || commandValue === 'graph'
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

    const snapshot = await loadTraceSnapshot(command.directory);
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
    if (command.format === 'json') {
      writeJson(io, {
        command: command.name,
        directory: command.directory,
        valid: snapshot.valid,
        projection: command.graphKind,
        graph: projection,
        diagnostics,
      });
    } else if (command.format === 'text') {
      io.stdout(`Graph: ${command.graphKind}\n`);
      io.stdout(`Nodes: ${String(projection.nodes.length)}\n`);
      io.stdout(`Edges: ${String(projection.edges.length)}\n`);
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
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli();
}
