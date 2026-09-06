import { RuntimeAdapterError, RuntimeConfigurationError } from './errors.js';
import type { ModelAdapter, ModelRequest, ModelResponse } from './types.js';

export interface OpenAICompatibleModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

function requiredEnv(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new RuntimeConfigurationError(
      'MISSING_MODEL_ENV',
      `Set ${name} in the example runtime environment before starting a model run.`,
    );
  }
  return normalized;
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return 30_000;
  }

  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RuntimeConfigurationError(
      'INVALID_MODEL_TIMEOUT',
      'ALS_MODEL_TIMEOUT_MS must be a positive integer.',
    );
  }
  return timeoutMs;
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts = content.flatMap((part) => {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) {
      return [];
    }
    const text = (part as { text?: unknown }).text;
    return typeof text === 'string' ? [text] : [];
  });
  return parts.length > 0 ? parts.join('') : undefined;
}

function responseOutput(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return undefined;
  }
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }
  const first = choices[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) {
    return undefined;
  }
  const message = (first as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return undefined;
  }
  return textFromContent((message as { content?: unknown }).content);
}

export class OpenAICompatibleModelAdapter implements ModelAdapter {
  readonly name = 'openai-compatible';
  readonly version = '0.1.0';

  constructor(private readonly config: OpenAICompatibleModelConfig) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): OpenAICompatibleModelAdapter {
    const baseUrl = (env.ALS_MODEL_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(
      /\/+$/u,
      '',
    );
    return new OpenAICompatibleModelAdapter({
      apiKey: requiredEnv('ALS_MODEL_API_KEY', env.ALS_MODEL_API_KEY),
      baseUrl,
      model: requiredEnv('ALS_MODEL_NAME', env.ALS_MODEL_NAME),
      timeoutMs: parseTimeout(env.ALS_MODEL_TIMEOUT_MS),
    });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: [{ role: 'user', content: request.prompt }],
          }),
          signal: controller.signal,
        });
      } catch {
        const timedOut = controller.signal.aborted;
        throw new RuntimeAdapterError(
          timedOut ? 'MODEL_TIMEOUT' : 'MODEL_NETWORK_ERROR',
          timedOut ? 'The model request timed out.' : 'The model request could not be sent.',
          true,
          'model',
        );
      }

      let body: unknown;
      try {
        body = (await response.json()) as unknown;
      } catch {
        body = undefined;
      }

      if (!response.ok) {
        throw new RuntimeAdapterError(
          `MODEL_HTTP_${response.status}`,
          `The model request failed with HTTP ${response.status}.`,
          response.status === 429 || response.status >= 500,
          'model',
        );
      }

      const output = responseOutput(body);
      if (output === undefined) {
        throw new RuntimeAdapterError(
          'MODEL_INVALID_RESPONSE',
          'The model response did not contain a text completion.',
          false,
          'model',
        );
      }
      return { output };
    } finally {
      clearTimeout(timeout);
    }
  }
}
