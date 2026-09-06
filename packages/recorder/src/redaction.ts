import { randomUUID } from 'node:crypto';

import type {
  EventEnvelope,
  JsonObject,
  JsonValue,
  RedactionEntry,
} from '@agent-loop-snapshot/schema';

import type { RecorderInterceptor } from './index.js';

export type RedactionStrategy = RedactionEntry['strategy'];
export type FieldRedactionStrategy = Exclude<RedactionStrategy, 'custom'>;

export interface FieldRedactionRule {
  path: string;
  category: string;
  strategy: FieldRedactionStrategy;
}

export interface RegexRedactionRule {
  pattern: RegExp;
  category: string;
  strategy: Exclude<RedactionStrategy, 'custom'>;
}

export interface RedactionContext {
  path: string;
  category: string;
  source: 'event' | 'artifact';
  eventType?: string;
}

export type RedactionDecision =
  { action: 'keep' } | { action: 'remove' } | { action: 'replace'; value: JsonValue };

export interface CustomRedactionRule {
  category: string;
  path?: string;
  redact(
    value: JsonValue,
    context: RedactionContext,
  ): RedactionDecision | void | Promise<RedactionDecision | void>;
}

export interface RedactionPipelineOptions {
  fieldRules?: readonly FieldRedactionRule[];
  regexRules?: readonly RegexRedactionRule[];
  customRedactors?: readonly CustomRedactionRule[];
}

export interface RedactArtifactOptions {
  mediaType: string;
  preview?: string;
}

export interface RedactedArtifact {
  content: string | Uint8Array;
  preview?: string;
  redactions: readonly RedactionEntry[];
}

export class RedactionError extends Error {
  constructor(
    readonly code: 'INVALID_PATH' | 'REDACTOR_FAILED' | 'UNSUPPORTED_VALUE',
    message: string,
  ) {
    super(message);
    this.name = 'RedactionError';
  }
}

interface RedactionExecutionOptions {
  pathPrefix: string;
  source: 'event' | 'artifact';
  eventType?: string;
}

interface ApplyResult {
  value: JsonValue;
  removed: boolean;
  changed: boolean;
  entries: RedactionEntry[];
}

interface NormalizedValue {
  value: JsonValue;
  changed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeValue(value: unknown, seen = new WeakSet<object>()): NormalizedValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return { value, changed: false };
  }

  if (typeof value === 'number') {
    return {
      value: Number.isFinite(value) ? value : String(value),
      changed: !Number.isFinite(value),
    };
  }

  if (value === undefined) {
    return { value: null, changed: true };
  }

  if (value instanceof Date) {
    return { value: value.toISOString(), changed: true };
  }

  if (value instanceof Error) {
    if (seen.has(value)) {
      throw new RedactionError('UNSUPPORTED_VALUE', 'A cyclic error value cannot be redacted.');
    }
    seen.add(value);
    const errorValue: JsonObject = {
      name: value.name,
      message: value.message,
      ...(value.stack === undefined ? {} : { stack: value.stack }),
    };
    for (const [key, nested] of Object.entries(value)) {
      const normalized = normalizeValue(nested, seen);
      errorValue[key] = normalized.value;
    }
    seen.delete(value);
    return { value: errorValue, changed: true };
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new RedactionError('UNSUPPORTED_VALUE', 'A cyclic array value cannot be redacted.');
    }
    seen.add(value);
    const normalized = value.map((nested) => normalizeValue(nested, seen).value);
    seen.delete(value);
    return { value: normalized, changed: true };
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new RedactionError('UNSUPPORTED_VALUE', 'A cyclic object value cannot be redacted.');
    }
    seen.add(value);
    const normalized: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) {
      const child = normalizeValue(nested, seen);
      normalized[key] = child.value;
    }
    seen.delete(value);
    return { value: normalized, changed: true };
  }

  return { value: null, changed: true };
}

function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function pathSegments(path: string): string[] {
  if (path === '') {
    return [];
  }
  if (!path.startsWith('/')) {
    throw new RedactionError(
      'INVALID_PATH',
      `Redaction path "${path}" must be an RFC 6901 JSON Pointer.`,
    );
  }
  return path
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function arrayIndex(segment: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(segment)) {
    return undefined;
  }
  return Number(segment);
}

function safeCategory(category: string): string {
  return category.replace(/[^A-Za-z0-9_.-]/g, '_') || 'secret';
}

function placeholder(category: string, strategy: 'mask' | 'reference'): string {
  if (strategy === 'mask') {
    return `[REDACTED:${safeCategory(category)}]`;
  }
  return `[REDACTED:${safeCategory(category)}:ref_${randomUUID()}]`;
}

function addEntry(entries: RedactionEntry[], entry: RedactionEntry): void {
  if (
    !entries.some(
      (existing) =>
        existing.category === entry.category &&
        existing.path === entry.path &&
        existing.strategy === entry.strategy,
    )
  ) {
    entries.push(entry);
  }
}

function decisionForStrategy(
  value: JsonValue,
  strategy: FieldRedactionStrategy,
  category: string,
): RedactionDecision {
  if (strategy === 'remove') {
    return { action: 'remove' };
  }
  if (strategy === 'mask' || strategy === 'reference') {
    return { action: 'replace', value: placeholder(category, strategy) };
  }
  return { action: 'replace', value };
}

function applyDecision(
  value: JsonValue,
  decision: RedactionDecision,
  category: string,
  strategy: RedactionStrategy,
  path: string,
): ApplyResult {
  if (decision.action === 'keep') {
    return { value, removed: false, changed: false, entries: [] };
  }

  const entry: RedactionEntry = { category, path, strategy };
  if (decision.action === 'remove') {
    return { value: null, removed: true, changed: true, entries: [entry] };
  }

  const replacement = cloneJson(decision.value);
  return {
    value: replacement,
    removed: false,
    changed: JSON.stringify(replacement) !== JSON.stringify(value),
    entries: [entry],
  };
}

async function applyPathRule(
  value: JsonValue,
  segments: readonly string[],
  rule: FieldRedactionRule | CustomRedactionRule,
  options: RedactionExecutionOptions,
  actualPath: string,
): Promise<ApplyResult> {
  if (segments.length === 0) {
    const context: RedactionContext = {
      path: actualPath,
      category: rule.category,
      source: options.source,
      ...(options.eventType === undefined ? {} : { eventType: options.eventType }),
    };
    let decision: RedactionDecision;
    if ('strategy' in rule) {
      decision = decisionForStrategy(value, rule.strategy, rule.category);
    } else {
      try {
        decision = (await rule.redact(value, context)) ?? { action: 'keep' };
      } catch {
        throw new RedactionError(
          'REDACTOR_FAILED',
          `Custom redactor for category "${rule.category}" failed.`,
        );
      }
    }
    const strategy: RedactionStrategy = 'strategy' in rule ? rule.strategy : 'custom';
    return applyDecision(value, decision, rule.category, strategy, actualPath);
  }

  if (Array.isArray(value)) {
    const segment = segments[0]!;
    const indexes =
      segment === '*' ? value.map((_, index) => index).reverse() : [arrayIndex(segment)];
    const entries: RedactionEntry[] = [];
    let changed = false;
    for (const index of indexes) {
      if (index === undefined || index >= value.length) {
        continue;
      }
      const child = await applyPathRule(
        value[index]!,
        segments.slice(1),
        rule,
        options,
        `${actualPath}/${index}`,
      );
      if (child.removed) {
        value.splice(index, 1);
        changed = true;
        continue;
      }
      if (child.changed) {
        value[index] = child.value;
        changed = true;
      }
      entries.push(...child.entries);
    }
    return { value, removed: false, changed, entries };
  }

  if (!isRecord(value)) {
    return { value, removed: false, changed: false, entries: [] };
  }

  const segment = segments[0]!;
  const keys = segment === '*' ? Object.keys(value) : [segment];
  const entries: RedactionEntry[] = [];
  let changed = false;
  for (const key of keys) {
    if (!(key in value)) {
      continue;
    }
    const child = await applyPathRule(
      value[key]!,
      segments.slice(1),
      rule,
      options,
      `${actualPath}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
    );
    if (child.removed) {
      delete value[key];
      changed = true;
    } else if (child.changed) {
      value[key] = child.value;
      changed = true;
    }
    entries.push(...child.entries);
  }
  return { value, removed: false, changed, entries };
}

async function applyGlobalCustomRule(
  value: JsonValue,
  rule: CustomRedactionRule,
  options: RedactionExecutionOptions,
  actualPath: string,
): Promise<ApplyResult> {
  const context: RedactionContext = {
    path: actualPath,
    category: rule.category,
    source: options.source,
    ...(options.eventType === undefined ? {} : { eventType: options.eventType }),
  };
  let decision: RedactionDecision | void;
  try {
    decision = await rule.redact(value, context);
  } catch {
    throw new RedactionError(
      'REDACTOR_FAILED',
      `Custom redactor for category "${rule.category}" failed.`,
    );
  }

  const applied = applyDecision(
    value,
    decision ?? { action: 'keep' },
    rule.category,
    'custom',
    actualPath,
  );
  if (applied.changed || applied.removed || (!isRecord(value) && !Array.isArray(value))) {
    return applied;
  }

  if (Array.isArray(applied.value)) {
    const entries = [...applied.entries];
    let changed: boolean = applied.changed;
    for (let index = 0; index < applied.value.length; index += 1) {
      const child = await applyGlobalCustomRule(
        applied.value[index]!,
        rule,
        options,
        `${actualPath}/${index}`,
      );
      if (child.removed) {
        applied.value.splice(index, 1);
        index -= 1;
        changed = true;
      } else if (child.changed) {
        applied.value[index] = child.value;
        changed = true;
      }
      entries.push(...child.entries);
    }
    return { ...applied, changed, entries };
  }

  const object = applied.value as JsonObject;
  const entries = [...applied.entries];
  let changed: boolean = applied.changed;
  for (const key of Object.keys(object)) {
    const child = await applyGlobalCustomRule(
      object[key]!,
      rule,
      options,
      `${actualPath}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
    );
    if (child.removed) {
      delete object[key];
      changed = true;
    } else if (child.changed) {
      object[key] = child.value;
      changed = true;
    }
    entries.push(...child.entries);
  }
  return { ...applied, changed, entries };
}

function regexDecision(strategy: Exclude<RedactionStrategy, 'custom'>, category: string): string {
  if (strategy === 'remove') {
    return '';
  }
  return placeholder(category, strategy);
}

function redactString(
  value: string,
  rules: readonly RegexRedactionRule[],
  path: string,
): { value: string; entries: RedactionEntry[] } {
  let current = value;
  const entries: RedactionEntry[] = [];
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    let changed = false;
    current = current.replace(rule.pattern, () => {
      changed = true;
      return regexDecision(rule.strategy, rule.category);
    });
    rule.pattern.lastIndex = 0;
    if (changed) {
      addEntry(entries, {
        category: rule.category,
        path,
        strategy: rule.strategy,
      });
    }
  }
  return { value: current, entries };
}

function applyRegexRules(
  value: JsonValue,
  rules: readonly RegexRedactionRule[],
  actualPath: string,
): ApplyResult {
  if (typeof value === 'string') {
    const result = redactString(value, rules, actualPath);
    return {
      value: result.value,
      removed: false,
      changed: result.value !== value,
      entries: result.entries,
    };
  }

  if (Array.isArray(value)) {
    const entries: RedactionEntry[] = [];
    let changed = false;
    value.forEach((child, index) => {
      const result = applyRegexRules(child, rules, `${actualPath}/${index}`);
      if (result.changed) {
        value[index] = result.value;
        changed = true;
      }
      entries.push(...result.entries);
    });
    return { value, removed: false, changed, entries };
  }

  if (!isRecord(value)) {
    return { value, removed: false, changed: false, entries: [] };
  }

  const entries: RedactionEntry[] = [];
  let changed = false;
  for (const key of Object.keys(value)) {
    const result = applyRegexRules(
      value[key]!,
      rules,
      `${actualPath}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
    );
    if (result.changed) {
      value[key] = result.value;
      changed = true;
    }
    entries.push(...result.entries);
  }
  return { value, removed: false, changed, entries };
}

async function redactJsonValue(
  input: unknown,
  pipeline: RedactionPipeline,
  options: RedactionExecutionOptions,
): Promise<{ value: JsonValue; redactions: RedactionEntry[] }> {
  const normalized = normalizeValue(input).value;
  let value = normalized;
  const redactions: RedactionEntry[] = [];

  for (const rule of pipeline.fieldRules) {
    const result = await applyPathRule(
      value,
      pathSegments(rule.path),
      rule,
      options,
      options.pathPrefix,
    );
    value = result.removed ? null : result.value;
    result.entries.forEach((entry) => addEntry(redactions, entry));
  }

  for (const rule of pipeline.customRedactors) {
    const result =
      rule.path === undefined
        ? await applyGlobalCustomRule(value, rule, options, options.pathPrefix)
        : await applyPathRule(value, pathSegments(rule.path), rule, options, options.pathPrefix);
    value = result.removed ? null : result.value;
    result.entries.forEach((entry) => addEntry(redactions, entry));
  }

  const regex = applyRegexRules(value, pipeline.regexRules, options.pathPrefix);
  value = regex.value;
  regex.entries.forEach((entry) => addEntry(redactions, entry));

  return { value, redactions };
}

function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith('text/') || /(?:json|javascript|xml|yaml|csv)/i.test(mediaType);
}

const defaultFieldRules: readonly FieldRedactionRule[] = [
  { path: '/authorization', category: 'authorization', strategy: 'reference' },
  { path: '/Authorization', category: 'authorization', strategy: 'reference' },
  { path: '/headers/authorization', category: 'authorization', strategy: 'reference' },
  { path: '/headers/Authorization', category: 'authorization', strategy: 'reference' },
  { path: '/api_key', category: 'api_key', strategy: 'reference' },
  { path: '/apiKey', category: 'api_key', strategy: 'reference' },
  { path: '/password', category: 'password', strategy: 'reference' },
  { path: '/secret', category: 'secret', strategy: 'reference' },
  { path: '/token', category: 'token', strategy: 'reference' },
];

const defaultRegexRules: readonly RegexRedactionRule[] = [
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    category: 'authorization',
    strategy: 'reference',
  },
  {
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    category: 'api_key',
    strategy: 'reference',
  },
  {
    pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g,
    category: 'api_key',
    strategy: 'reference',
  },
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    category: 'api_key',
    strategy: 'reference',
  },
];

export class RedactionPipeline {
  readonly fieldRules: readonly FieldRedactionRule[];
  readonly regexRules: readonly RegexRedactionRule[];
  readonly customRedactors: readonly CustomRedactionRule[];

  constructor(options: RedactionPipelineOptions = {}) {
    options.fieldRules?.forEach((rule) => pathSegments(rule.path));
    options.customRedactors?.forEach((rule) => {
      if (rule.path !== undefined) {
        pathSegments(rule.path);
      }
    });
    this.fieldRules = options.fieldRules ?? [];
    this.regexRules = options.regexRules ?? [];
    this.customRedactors = options.customRedactors ?? [];
  }

  async redactEvent(
    event: Readonly<EventEnvelope<string, unknown>>,
  ): Promise<EventEnvelope<string, unknown>> {
    const result = await redactJsonValue(event.payload, this, {
      pathPrefix: '/payload',
      source: 'event',
      eventType: event.type,
    });
    const existing = event.security?.redactions ?? [];
    const redactions = [...existing];
    result.redactions.forEach((entry) => addEntry(redactions, entry));

    return {
      ...event,
      payload: result.value,
      security: {
        side_effect: event.security?.side_effect ?? 'read_only',
        redactions,
      },
    };
  }

  asInterceptor(): RecorderInterceptor {
    return {
      beforeAppend: (event) => this.redactEvent(event),
    };
  }

  async redactArtifact(
    content: string | Uint8Array,
    options: RedactArtifactOptions,
  ): Promise<RedactedArtifact> {
    const isString = typeof content === 'string';
    const bytes = isString ? undefined : new Uint8Array(content);
    const text = isString
      ? content
      : isTextMediaType(options.mediaType)
        ? new TextDecoder().decode(bytes)
        : undefined;

    let redactedContent: string | Uint8Array = content;
    let redactions: RedactionEntry[] = [];
    if (text !== undefined) {
      let parsed: unknown = text;
      let parsedJson = false;
      if (/json/i.test(options.mediaType)) {
        try {
          parsed = JSON.parse(text) as unknown;
          parsedJson = true;
        } catch {
          parsed = text;
        }
      }

      const result = await redactJsonValue(parsed, this, {
        pathPrefix: '/artifact',
        source: 'artifact',
      });
      redactions = result.redactions;
      if (parsedJson) {
        redactedContent = JSON.stringify(result.value);
      } else if (typeof result.value === 'string') {
        redactedContent = result.value;
      } else {
        redactedContent = JSON.stringify(result.value);
      }
      if (!isString) {
        redactedContent = new TextEncoder().encode(redactedContent as string);
      }
    }

    let preview = options.preview;
    if (preview !== undefined) {
      const previewResult = await redactJsonValue(preview, this, {
        pathPrefix: '/artifact/preview',
        source: 'artifact',
      });
      preview = typeof previewResult.value === 'string' ? previewResult.value : undefined;
      previewResult.redactions.forEach((entry) => addEntry(redactions, entry));
    }

    return {
      content: redactedContent,
      ...(preview === undefined ? {} : { preview }),
      redactions,
    };
  }
}

export function createDefaultRedactionPipeline(
  options: RedactionPipelineOptions = {},
): RedactionPipeline {
  return new RedactionPipeline({
    ...options,
    fieldRules: [...defaultFieldRules, ...(options.fieldRules ?? [])],
    regexRules: [...defaultRegexRules, ...(options.regexRules ?? [])],
  });
}
