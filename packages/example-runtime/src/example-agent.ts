import { randomUUID } from 'node:crypto';

import type {
  ArtifactReference,
  EventId,
  JsonObject,
  JsonValue,
  RuntimeDescriptor,
} from '@agent-loop-snapshot/schema';
import { Recorder, hashState } from '@agent-loop-snapshot/recorder';

import { RuntimeAdapterError, errorInfoFrom } from './errors.js';
import type {
  ExampleAgentInput,
  ExampleAgentOptions,
  ExampleAgentRunResult,
  ModelResponse,
  ToolAdapter,
  ToolRequest,
} from './types.js';

const defaultRuntime: RuntimeDescriptor = {
  name: 'example-runtime',
  version: '0.1.0',
  adapter: '@agent-loop-snapshot/example-runtime',
};

interface ToolResult {
  name: string;
  output: JsonValue | ArtifactReference;
}

interface CompletedToolResult extends ToolResult {
  completedEventId: EventId;
}

function isArtifactReference(value: JsonValue | ArtifactReference): value is ArtifactReference {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'digest' in value &&
    'media_type' in value &&
    'byte_length' in value
  );
}

function stateValue(value: JsonValue | ArtifactReference): JsonValue {
  if (!isArtifactReference(value)) {
    return value;
  }
  return {
    schema_version: value.schema_version,
    digest: value.digest,
    media_type: value.media_type,
    byte_length: value.byte_length,
    ...(value.preview === undefined ? {} : { preview: value.preview }),
  };
}

export class ExampleAgentRuntime {
  private readonly recorder: Recorder;
  private readonly model: ExampleAgentOptions['model'];
  private readonly tools: readonly ToolAdapter[];
  private readonly maxToolAttempts: number;
  private readonly runtime: RuntimeDescriptor;

  constructor(options: ExampleAgentOptions) {
    this.recorder = options.recorder;
    this.model = options.model;
    this.tools = options.tools;
    this.maxToolAttempts = Math.max(1, Math.floor(options.maxToolAttempts ?? 2));
    this.runtime = options.runtime ?? defaultRuntime;
  }

  async run(input: ExampleAgentInput): Promise<ExampleAgentRunResult> {
    const run = await this.recorder.startRun({
      runtime: this.runtime,
      input: { goal: input.goal },
    });
    let state: JsonObject = { goal: input.goal, tool_results: {} };

    try {
      const goalChanged = await this.recorder.appendEvent(run.context(), {
        type: 'state.changed',
        payload: { path: '/goal', operation: 'set', value: input.goal },
      });

      const modelCorrelationKey = `model:${randomUUID()}`;
      const modelRequested = await this.recorder.appendEvent(run.context([goalChanged.event_id]), {
        type: 'model.requested',
        payload: {
          correlation_key: modelCorrelationKey,
          model: this.model.name,
          input: input.goal,
        },
      });

      let modelResponse: ModelResponse;
      try {
        modelResponse = await this.model.complete({
          correlationKey: modelCorrelationKey,
          prompt: input.goal,
          attempt: 1,
        });
      } catch (error) {
        await this.recorder.appendEvent(run.context([modelRequested.event_id]), {
          type: 'model.failed',
          payload: {
            correlation_key: modelCorrelationKey,
            error: errorInfoFrom(error, 'MODEL_ADAPTER_FAILED', 'model'),
            attempt: 1,
          },
        });
        throw error;
      }

      const modelCompleted = await this.recorder.appendEvent(
        run.context([modelRequested.event_id]),
        {
          type: 'model.completed',
          payload: { correlation_key: modelCorrelationKey, output: modelResponse.output },
        },
      );

      state = { ...state, answer: modelResponse.output };
      const answerChanged = await this.recorder.appendEvent(
        run.context([modelCompleted.event_id]),
        {
          type: 'state.changed',
          payload: { path: '/answer', operation: 'set', value: modelResponse.output },
        },
      );

      const toolResults = await Promise.all(
        this.tools.map((tool, index) =>
          this.runTool(run, modelCompleted.event_id, input.goal, tool, index),
        ),
      );
      const resultObject: JsonObject = Object.fromEntries(
        toolResults.map((result) => [result.name, stateValue(result.output)]),
      );
      state = { ...state, tool_results: resultObject };
      const toolsChanged = await this.recorder.appendEvent(
        run.context([
          answerChanged.event_id,
          ...toolResults.map((result) => result.completedEventId),
        ]),
        {
          type: 'state.changed',
          payload: { path: '/tool_results', operation: 'merge', value: resultObject },
        },
      );

      await this.recorder.appendEvent(run.context([toolsChanged.event_id]), {
        type: 'decision.recorded',
        payload: {
          decision: 'complete',
          basis_summary: 'The model result and all read-only tools completed.',
          success_conditions: ['model result recorded', 'all read-only tools completed'],
        },
      });
      await this.recorder.checkpoint(run, {
        state,
        stateHash: hashState(state),
      });
      const finalStateHash = hashState(state);
      await this.recorder.completeRun(run, {
        final_state_hash: finalStateHash,
        output: { answer: modelResponse.output, tool_results: resultObject },
      });

      return {
        run,
        status: run.status,
        finalState: state,
        finalStateHash,
        manifest: this.recorder.getManifest(run),
      };
    } catch (error) {
      if (run.status === 'running') {
        await this.recorder.failRun(run, errorInfoFrom(error, 'EXAMPLE_RUNTIME_FAILED', 'runtime'));
      }
      const finalStateHash = hashState(state);
      return {
        run,
        status: run.status,
        finalState: state,
        finalStateHash,
        manifest: this.recorder.getManifest(run),
      };
    }
  }

  private async runTool(
    run: ExampleAgentRunResult['run'],
    parentEventId: EventId,
    goal: string,
    tool: ToolAdapter,
    index: number,
  ): Promise<CompletedToolResult> {
    if (tool.sideEffect !== 'read_only') {
      throw new RuntimeAdapterError(
        'TOOL_SIDE_EFFECT_NOT_ALLOWED',
        `Tool "${tool.name}" is not read-only and cannot run in this example.`,
        false,
        'policy',
      );
    }

    const correlationKey = `tool:${tool.name}:${index}:${randomUUID()}`;
    let parentIds: readonly EventId[] = [parentEventId];
    for (let attempt = 1; attempt <= this.maxToolAttempts; attempt += 1) {
      const requested = await this.recorder.appendEvent(run.context(parentIds), {
        type: 'tool.requested',
        payload: {
          correlation_key: correlationKey,
          tool: tool.name,
          arguments: { goal },
        },
      });

      const request: ToolRequest = {
        correlationKey,
        arguments: { goal },
        attempt,
        runId: run.runId,
      };
      try {
        const output = await tool.call(request);
        const completed = await this.recorder.appendEvent(run.context([requested.event_id]), {
          type: 'tool.completed',
          payload: { correlation_key: correlationKey, output },
        });
        return { name: tool.name, output, completedEventId: completed.event_id };
      } catch (error) {
        const failed = await this.recorder.appendEvent(run.context([requested.event_id]), {
          type: 'tool.failed',
          payload: {
            correlation_key: correlationKey,
            error: errorInfoFrom(error, 'TOOL_ADAPTER_FAILED', 'tool'),
            attempt,
          },
        });
        if (
          error instanceof RuntimeAdapterError &&
          error.retryable &&
          attempt < this.maxToolAttempts
        ) {
          parentIds = [failed.event_id];
          continue;
        }
        throw error;
      }
    }
    throw new RuntimeAdapterError(
      'TOOL_ATTEMPTS_EXHAUSTED',
      'The tool retry budget was exhausted.',
      false,
      'tool',
    );
  }
}

function tool(name: string, call: ToolAdapter['call']): ToolAdapter {
  return { name, version: '0.1.0', sideEffect: 'read_only', call };
}

export function createDefaultExampleTools(): readonly ToolAdapter[] {
  return [
    tool('read_goal_metadata', async (request) => {
      const goal = request.arguments.goal;
      const text = typeof goal === 'string' ? goal : '';
      return {
        character_count: text.length,
        word_count: text.trim() === '' ? 0 : text.trim().split(/\s+/u).length,
      };
    }),
    tool('read_runtime_context', async () => ({
      runtime: 'example-runtime',
      side_effect: 'read_only',
    })),
  ];
}
