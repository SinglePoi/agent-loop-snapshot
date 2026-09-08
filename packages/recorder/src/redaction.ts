import { randomUUID } from 'node:crypto';

import { snapshotSchemaVersion } from '@agent-loop-snapshot/schema/protocol';
import type {
  ArtifactReference,
  Checkpoint,
  EventEnvelope,
  JsonObject,
  JsonValue,
  RedactionEntry,
} from '@agent-loop-snapshot/schema';

import { hashState } from './checkpoints.js';
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
  source: 'event' | 'artifact' | 'checkpoint';
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
    readonly code:
      | 'INVALID_PATH'
      | 'REDACTOR_FAILED'
      | 'UNSUPPORTED_VALUE'
      | 'PROTOCOL_REDACTION_UNREPRESENTABLE'
      | 'STATE_REDACTION_UNREPRESENTABLE'
      | 'STATE_REDACTION_CONTEXT_REQUIRED',
    message: string,
  ) {
    super(message);
    this.name = 'RedactionError';
  }
}

interface RedactionExecutionOptions {
  pathPrefix: string;
  source: RedactionContext['source'];
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

function isArtifactReference(value: unknown): value is ArtifactReference {
  return (
    isRecord(value) &&
    value.schema_version === snapshotSchemaVersion &&
    typeof value.digest === 'string' &&
    typeof value.media_type === 'string' &&
    typeof value.byte_length === 'number'
  );
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

/** Stable JSON identity: object property order is not part of a JSON value's identity. */
function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(',')}}`;
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

function pointerPath(segments: readonly string[]): string {
  return segments.length === 0
    ? ''
    : `/${segments.map((segment) => segment.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
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

function isRedactionPlaceholder(value: JsonValue): value is string {
  return (
    typeof value === 'string' &&
    /^\[REDACTED:[A-Za-z0-9_.-]+(?::ref_[0-9a-f-]{36})?\]$/u.test(value)
  );
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
  pipeline: RedactionPipeline,
): RedactionDecision {
  if (strategy === 'remove') {
    return { action: 'remove' };
  }
  if (strategy === 'mask' || strategy === 'reference') {
    if (isRedactionPlaceholder(value)) {
      return { action: 'keep' };
    }
    return { action: 'replace', value: pipeline.placeholderFor(value, category, strategy) };
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
  pipeline: RedactionPipeline,
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
      decision = decisionForStrategy(value, rule.strategy, rule.category, pipeline);
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
        pipeline,
        options,
        `${actualPath}/${index}`,
      );
      if (child.removed) {
        entries.push(...child.entries);
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
      pipeline,
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

function regexDecision(
  value: string,
  strategy: Exclude<RedactionStrategy, 'custom'>,
  category: string,
  pipeline: RedactionPipeline,
): string {
  if (strategy === 'remove') {
    return '';
  }
  return pipeline.placeholderFor(value, category, strategy);
}

function redactString(
  value: string,
  rules: readonly RegexRedactionRule[],
  path: string,
  pipeline: RedactionPipeline,
): { value: string; entries: RedactionEntry[] } {
  let current = value;
  const entries: RedactionEntry[] = [];
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    let changed = false;
    current = current.replace(rule.pattern, (match) => {
      changed = true;
      return regexDecision(match, rule.strategy, rule.category, pipeline);
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
  pipeline: RedactionPipeline,
): ApplyResult {
  if (typeof value === 'string') {
    const result = redactString(value, rules, actualPath, pipeline);
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
      const result = applyRegexRules(child, rules, `${actualPath}/${index}`, pipeline);
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
      pipeline,
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
      pipeline,
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
        : await applyPathRule(
            value,
            pathSegments(rule.path),
            rule,
            pipeline,
            options,
            options.pathPrefix,
          );
    value = result.removed ? null : result.value;
    result.entries.forEach((entry) => addEntry(redactions, entry));
  }

  const regex = applyRegexRules(value, pipeline.regexRules, options.pathPrefix, pipeline);
  value = regex.value;
  regex.entries.forEach((entry) => addEntry(redactions, entry));

  return { value, redactions };
}

type StateChangeOperation = 'set' | 'merge' | 'delete' | 'append';

const unsafeStatePathSegments = new Set(['__proto__', 'constructor', 'prototype']);

interface StateChangePayloadForRedaction {
  readonly operation: StateChangeOperation;
  readonly path: string;
  readonly value: unknown;
}

interface StateChangeProjection {
  readonly root: JsonValue;
  readonly targetSegments: readonly string[];
  readonly appended: boolean;
}

function stateChangePayloadForRedaction(
  value: unknown,
): StateChangePayloadForRedaction | undefined {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    (value.operation !== 'delete' && !Object.hasOwn(value, 'value')) ||
    (value.operation !== 'set' &&
      value.operation !== 'merge' &&
      value.operation !== 'delete' &&
      value.operation !== 'append')
  ) {
    return undefined;
  }
  return {
    operation: value.operation,
    path: value.path,
    value: value.value,
  };
}

function ruleMatchesPrefix(rule: readonly string[], path: readonly string[]): boolean {
  return (
    rule.length <= path.length &&
    rule.every((segment, index) => segment === '*' || segment === path[index])
  );
}

function pathsCanOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left
    .slice(0, Math.min(left.length, right.length))
    .every((segment, index) => segment === '*' || right[index] === '*' || segment === right[index]);
}

/** Rules may have replaced an array or compacted its elements before this original index. */
function assertStateArrayAddressesAreStable(
  payload: StateChangePayloadForRedaction,
  pipeline: RedactionPipeline,
): void {
  const target = pathSegments(payload.path);
  for (let depth = 0; depth < target.length; depth += 1) {
    if (arrayIndex(target[depth]!) === undefined) continue;
    const parent = target.slice(0, depth);
    const affectsAddress = (path: string, canRemoveElement: boolean): boolean => {
      const rule = pathSegments(path);
      if (rule.length <= depth) return ruleMatchesPrefix(rule, parent);
      return (
        canRemoveElement &&
        rule.length === depth + 1 &&
        ruleMatchesPrefix(rule.slice(0, depth), parent) &&
        (rule[depth] === '*' || arrayIndex(rule[depth]!) !== undefined)
      );
    };
    if (
      pipeline.fieldRules.some((rule) => affectsAddress(rule.path, rule.strategy === 'remove')) ||
      pipeline.customRedactors.some(
        (rule) => rule.path === undefined || affectsAddress(rule.path, true),
      )
    ) {
      throw new RedactionError(
        'STATE_REDACTION_CONTEXT_REQUIRED',
        'Redaction may have shifted an array address. Record the complete updated array with set instead.',
      );
    }
  }
}

/**
 * Incremental state events only carry their changed value. A custom callback at an
 * ancestor would otherwise see a synthetic partial object instead of the current state.
 */
function assertCustomRulesHaveStateContext(
  payload: StateChangePayloadForRedaction,
  pipeline: RedactionPipeline,
): void {
  if (pipeline.customRedactors.length === 0 || payload.operation === 'delete') {
    return;
  }

  const target = pathSegments(payload.path);
  for (const rule of pipeline.customRedactors) {
    if (rule.path === undefined) {
      throw new RedactionError(
        'STATE_REDACTION_CONTEXT_REQUIRED',
        'A global custom redactor requires the complete state. Use a scoped rule and record the complete updated parent with set instead.',
      );
    }
    const rulePath = pathSegments(rule.path);
    const ruleIsAncestorOrTarget =
      rulePath.length <= target.length && pathsCanOverlap(rulePath, target);
    const requiresExistingTarget = payload.operation === 'merge' && ruleIsAncestorOrTarget;
    const requiresAncestorState =
      payload.operation === 'set' && rulePath.length < target.length && ruleIsAncestorOrTarget;
    if (requiresExistingTarget || requiresAncestorState) {
      throw new RedactionError(
        'STATE_REDACTION_CONTEXT_REQUIRED',
        'Custom redaction requires state outside this incremental change. Record the complete updated parent with set instead.',
      );
    }
  }
}

/** Deletes carry no original state: only allow rules that preserve their addressing semantics. */
function assertDeleteRulesAreSafe(path: string, pipeline: RedactionPipeline): void {
  const target = pathSegments(path);
  for (const rule of pipeline.fieldRules) {
    const segments = pathSegments(rule.path);
    if (
      ruleMatchesPrefix(segments, target) &&
      (rule.strategy === 'remove' || segments.length < target.length)
    ) {
      throw new RedactionError(
        'STATE_REDACTION_UNREPRESENTABLE',
        'Redaction may remove the delete target or replace an ancestor. Record the complete updated parent with set instead.',
      );
    }
  }

  // Numeric pointer segments may address arrays. Without container state, also treat numeric
  // object keys conservatively. Removing an element can shift any later addressed element.
  const arrayParents = target.flatMap((segment, index) =>
    arrayIndex(segment) === undefined ? [] : [{ path: target.slice(0, index), index }],
  );
  const contextualField = pipeline.fieldRules.some((rule) => {
    const segments = pathSegments(rule.path);
    return arrayParents.some((parent) => {
      if (
        segments.length <= parent.index ||
        !ruleMatchesPrefix(segments.slice(0, parent.index), parent.path)
      )
        return false;
      const element = segments[parent.index]!;
      const matchesElement = element === '*' || arrayIndex(element) !== undefined;
      const removesElement = rule.strategy === 'remove' && segments.length === parent.index + 1;
      const shiftsIndexedRules =
        parent.index === target.length - 1 && arrayIndex(element) !== undefined;
      return matchesElement && (removesElement || shiftsIndexedRules);
    });
  });
  const contextualCustom = pipeline.customRedactors.some((rule) => {
    if (rule.path === undefined) return true;
    const segments = pathSegments(rule.path);
    const overlaps = ruleMatchesPrefix(segments.slice(0, target.length), target);
    return (
      overlaps ||
      arrayParents.some((parent) => ruleMatchesPrefix(segments.slice(0, parent.index), parent.path))
    );
  });
  if (contextualField || contextualCustom) {
    throw new RedactionError(
      'STATE_REDACTION_CONTEXT_REQUIRED',
      'Delete redaction requires the original state or array positions for these rules. Record the complete updated parent with set instead.',
    );
  }
}

function virtualStateContainer(segment: string, value: JsonValue): JsonValue {
  // A numeric pointer token can be an object key, not an array index. Keep every
  // virtual ancestor as a single own property: no rounding, holes or index-sized
  // allocation. Real arrays in the supplied value keep their normal array semantics;
  // the address/context guards above handle operations that require container state.
  const container: JsonObject = {};
  Object.defineProperty(container, segment, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
  return container;
}

function stateChangeProjection(
  payload: StateChangePayloadForRedaction,
): StateChangeProjection | undefined {
  let segments: string[];
  try {
    segments = pathSegments(payload.path);
  } catch {
    return undefined;
  }
  if (segments.length === 0 || segments.some((segment) => unsafeStatePathSegments.has(segment))) {
    return undefined;
  }

  const trailingSet = payload.operation === 'set' && segments.at(-1) === '-';
  const appended = payload.operation === 'append' || trailingSet;
  const targetSegments =
    payload.operation === 'append' ? segments : trailingSet ? segments.slice(0, -1) : segments;
  let root: JsonValue = appended
    ? [normalizeValue(payload.value).value]
    : normalizeValue(payload.value).value;
  for (
    let index = (trailingSet ? segments.length - 1 : segments.length) - 1;
    index >= 0;
    index -= 1
  ) {
    root = virtualStateContainer(segments[index]!, root);
  }
  return { root, targetSegments, appended };
}

function valueAtStatePath(value: JsonValue, segments: readonly string[]): JsonValue | undefined {
  let current = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = arrayIndex(segment);
      if (index === undefined || !Object.hasOwn(current, index)) {
        return undefined;
      }
      current = current[index]!;
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment] as JsonValue;
  }
  return current;
}

/** A projected append occupies virtual index zero; report it as the protocol's trailing dash. */
function stateRedactionEntries(
  entries: readonly RedactionEntry[],
  projection: StateChangeProjection,
): RedactionEntry[] {
  if (!projection.appended) {
    return [...entries];
  }
  const virtualPrefix = pointerPath([...projection.targetSegments, '0']);
  const appendPrefix = pointerPath([...projection.targetSegments, '-']);
  return entries.map((entry) =>
    entry.path === virtualPrefix || entry.path.startsWith(`${virtualPrefix}/`)
      ? { ...entry, path: `${appendPrefix}${entry.path.slice(virtualPrefix.length)}` }
      : entry,
  );
}

/** An isolated append has no reliable index; never evaluate index-sensitive rules at zero. */
function assertAppendRulesArePositionIndependent(
  projection: StateChangeProjection,
  pipeline: RedactionPipeline,
): void {
  if (!projection.appended) {
    return;
  }
  const target = projection.targetSegments;
  const overlaps = (segments: readonly string[]): boolean =>
    segments
      .slice(0, Math.min(segments.length, target.length))
      .every((segment, index) => segment === '*' || segment === target[index]);
  const indexedField = pipeline.fieldRules.some((rule) => {
    const segments = pathSegments(rule.path);
    return overlaps(segments) && arrayIndex(segments[target.length] ?? '') !== undefined;
  });
  // A custom callback can inspect the concrete index in context.path, even with a wildcard.
  const contextualCustom = pipeline.customRedactors.some(
    (rule) => rule.path === undefined || overlaps(pathSegments(rule.path)),
  );
  if (indexedField || contextualCustom) {
    throw new RedactionError(
      'STATE_REDACTION_CONTEXT_REQUIRED',
      'Append redaction requires the actual array position for these rules. Record the updated array with set instead.',
    );
  }
}

async function redactStateChangeValue(
  payload: StateChangePayloadForRedaction,
  pipeline: RedactionPipeline,
): Promise<ApplyResult | undefined> {
  if (payload.operation === 'delete' || isArtifactReference(payload.value)) {
    return undefined;
  }
  assertCustomRulesHaveStateContext(payload, pipeline);
  const projection = stateChangeProjection(payload);
  if (projection === undefined) {
    return undefined;
  }
  assertAppendRulesArePositionIndependent(projection, pipeline);
  const result = await redactJsonValue(projection.root, pipeline, {
    pathPrefix: '',
    source: 'event',
    eventType: 'state.changed',
  });
  const target = valueAtStatePath(result.value, projection.targetSegments);
  if (projection.appended && !Array.isArray(target)) {
    throw new RedactionError(
      'STATE_REDACTION_UNREPRESENTABLE',
      'Redaction removed or replaced the append container. Record the updated parent state with set instead.',
    );
  }
  const value = projection.appended && Array.isArray(target) ? target.at(-1) : target;
  if (value === undefined) {
    throw new RedactionError(
      'STATE_REDACTION_UNREPRESENTABLE',
      'Redaction removed the state change target. Record the updated parent state with set instead.',
    );
  }
  if (payload.operation === 'merge' && !isRecord(value)) {
    throw new RedactionError(
      'STATE_REDACTION_UNREPRESENTABLE',
      'Redaction replaced the merge value with a non-object. Record the complete updated target with set instead.',
    );
  }
  if (payload.operation === 'merge' && isRecord(value)) {
    const original = normalizeValue(payload.value).value;
    if (isRecord(original) && Object.keys(original).some((key) => !Object.hasOwn(value, key))) {
      throw new RedactionError(
        'STATE_REDACTION_UNREPRESENTABLE',
        'Redaction removed a merge patch key, which would leave the existing value unchanged. Record the complete updated target with set instead.',
      );
    }
  }
  return {
    value,
    removed: false,
    changed: JSON.stringify(value) !== JSON.stringify(payload.value),
    entries: stateRedactionEntries(result.redactions, projection),
  };
}

async function redactStateChangePayload(
  payload: unknown,
  pipeline: RedactionPipeline,
): Promise<{ value: JsonValue; redactions: RedactionEntry[] } | undefined> {
  const stateChange = stateChangePayloadForRedaction(payload);
  if (stateChange === undefined || !isRecord(payload)) {
    return undefined;
  }

  if (stateChange.operation === 'delete') {
    assertDeleteRulesAreSafe(stateChange.path, pipeline);
  }
  // Address safety applies even when the value is handled at the artifact boundary.
  assertStateArrayAddressesAreStable(stateChange, pipeline);

  // Only set at a trailing dash is ambiguous: it can address an object property
  // or append to an array. Exact dash rules do not apply to array elements, so
  // evaluating either interpretation alone could leak data or change replay state.
  const statePath = pathSegments(stateChange.path);
  if (stateChange.operation === 'set' && statePath.at(-1) === '-') {
    const depth = statePath.length - 1;
    if (
      pipeline.fieldRules.some((rule) => {
        const segments = pathSegments(rule.path);
        return (
          segments[depth] === '-' &&
          pathsCanOverlap(segments.slice(0, depth), statePath.slice(0, depth))
        );
      })
    ) {
      throw new RedactionError(
        'STATE_REDACTION_CONTEXT_REQUIRED',
        'A trailing dash may be an object key or an array append. Record the complete updated parent with set instead.',
      );
    }
  }

  // Field/custom rules address state data, not the protocol's operation and JSON Pointer.
  // A regex-detected secret in a control cannot be masked without changing semantics.
  const controls = { operation: stateChange.operation, path: stateChange.path };
  if (applyRegexRules({ ...controls }, pipeline.regexRules, '/payload', pipeline).changed) {
    throw new RedactionError(
      'STATE_REDACTION_UNREPRESENTABLE',
      'A state control field requires redaction. Use a non-sensitive state path instead.',
    );
  }
  const projected = stateChange.operation !== 'delete' && !isArtifactReference(stateChange.value);
  const stateResult = projected ? await redactStateChangeValue(stateChange, pipeline) : undefined;
  if (projected && stateResult === undefined) {
    throw new RedactionError(
      'STATE_REDACTION_UNREPRESENTABLE',
      'The state change cannot be safely projected for redaction.',
    );
  }
  const metadata = { ...payload };
  delete metadata.operation;
  delete metadata.path;
  if (projected) delete metadata.value;
  const metadataResult = await redactJsonValue(metadata, pipeline, {
    pathPrefix: '/payload',
    source: 'event',
    eventType: 'state.changed',
  });
  if (!isRecord(metadataResult.value)) {
    throw new RedactionError(
      'STATE_REDACTION_UNREPRESENTABLE',
      'Redaction replaced the state event metadata with a non-object.',
    );
  }

  const redactions = [...metadataResult.redactions];
  stateResult?.entries.forEach((entry) => addEntry(redactions, entry));
  return {
    value: {
      ...metadataResult.value,
      ...controls,
      ...(stateResult === undefined ? {} : { value: stateResult.value }),
    },
    redactions,
  };
}

/**
 * These fields bind an event to its lifecycle, replay correlation, or checkpoint.
 * A field rule can name the same word as ordinary data, but must never corrupt this
 * protocol metadata. Regex matches are rejected rather than silently preserving a
 * potentially sensitive control value.
 */
const protocolControlPaths: Readonly<Record<string, readonly (readonly string[])[]>> = {
  'run.started': [['runtime']],
  'run.completed': [['final_state_hash']],
  'run.failed': [
    ['error', 'code'],
    ['error', 'retryable'],
    ['error', 'kind'],
  ],
  'model.requested': [['correlation_key'], ['model']],
  'model.completed': [['correlation_key']],
  'model.failed': [
    ['correlation_key'],
    ['attempt'],
    ['error', 'code'],
    ['error', 'retryable'],
    ['error', 'kind'],
  ],
  'tool.requested': [['correlation_key'], ['tool']],
  'tool.completed': [['correlation_key']],
  'tool.failed': [
    ['correlation_key'],
    ['attempt'],
    ['error', 'code'],
    ['error', 'retryable'],
    ['error', 'kind'],
  ],
  'checkpoint.created': [['checkpoint_id'], ['last_event_id'], ['sequence'], ['state_hash']],
  'verification.completed': [['verifier'], ['result']],
};

function valueAtObjectPath(value: JsonObject, segments: readonly string[]): JsonValue | undefined {
  let current: JsonValue = value;
  for (const segment of segments) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment]!;
  }
  return current;
}

function deleteObjectPath(value: JsonObject, segments: readonly string[]): void {
  if (segments.length === 0) return;
  let current = value;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!isRecord(next)) return;
    current = next;
  }
  delete current[segments.at(-1)!];
}

function setObjectPath(
  value: JsonObject,
  segments: readonly string[],
  replacement: JsonValue,
): void {
  let current = value;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (isRecord(existing)) {
      current = existing;
      continue;
    }
    const child: JsonObject = {};
    Object.defineProperty(current, segment, {
      configurable: true,
      enumerable: true,
      value: child,
      writable: true,
    });
    current = child;
  }
  Object.defineProperty(current, segments.at(-1)!, {
    configurable: true,
    enumerable: true,
    value: replacement,
    writable: true,
  });
}

function ruleWouldReplaceProtocolContainer(
  rulePath: readonly string[],
  controlPath: readonly string[],
): boolean {
  return (
    rulePath.length < controlPath.length &&
    pathsCanOverlap(rulePath, controlPath.slice(0, rulePath.length))
  );
}

function assertProtocolContainersArePreserved(
  eventType: string,
  controls: readonly (readonly string[])[],
  pipeline: RedactionPipeline,
): void {
  for (const rule of [...pipeline.fieldRules, ...pipeline.customRedactors]) {
    if (rule.path === undefined) continue;
    const rulePath = pathSegments(rule.path);
    if (controls.some((controlPath) => ruleWouldReplaceProtocolContainer(rulePath, controlPath))) {
      throw new RedactionError(
        'PROTOCOL_REDACTION_UNREPRESENTABLE',
        `A redaction rule would replace protocol metadata for ${eventType}. Use a rule for a payload data field instead.`,
      );
    }
  }
}

async function redactProtocolEventPayload(
  payload: unknown,
  eventType: string,
  pipeline: RedactionPipeline,
): Promise<{ value: JsonValue; redactions: RedactionEntry[] } | undefined> {
  const controls = protocolControlPaths[eventType];
  if (controls === undefined || !isRecord(payload)) {
    return undefined;
  }
  const normalized = normalizeValue(payload).value;
  if (!isRecord(normalized)) {
    return undefined;
  }
  assertProtocolContainersArePreserved(eventType, controls, pipeline);
  const values = controls.flatMap((segments) => {
    const value = valueAtObjectPath(normalized, segments);
    return value === undefined ? [] : [{ segments, value }];
  });
  for (const control of values) {
    if (
      applyRegexRules(
        cloneJson(control.value),
        pipeline.regexRules,
        `/payload${pointerPath(control.segments)}`,
        pipeline,
      ).changed
    ) {
      throw new RedactionError(
        'PROTOCOL_REDACTION_UNREPRESENTABLE',
        `A protocol field for ${eventType} requires redaction. Use non-sensitive protocol metadata instead.`,
      );
    }
  }
  const metadata = cloneJson(normalized) as JsonObject;
  values.forEach(({ segments }) => deleteObjectPath(metadata, segments));
  const redacted = await redactJsonValue(metadata, pipeline, {
    pathPrefix: '/payload',
    source: 'event',
    eventType,
  });
  if (!isRecord(redacted.value)) {
    throw new RedactionError(
      'PROTOCOL_REDACTION_UNREPRESENTABLE',
      `Redaction replaced the ${eventType} payload with a non-object.`,
    );
  }
  const redactedPayload = redacted.value as JsonObject;
  values.forEach(({ segments, value }) => setObjectPath(redactedPayload, segments, value));
  return { value: redactedPayload, redactions: redacted.redactions };
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
  private readonly referencePlaceholders = new Map<string, string>();

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

  placeholderFor(value: JsonValue, category: string, strategy: 'mask' | 'reference'): string {
    if (strategy === 'mask') {
      return placeholder(category, strategy);
    }
    // A reference represents the identity of the redacted value, not the rule
    // that found it. The same state value can reach events and checkpoints
    // through different field or regex categories.
    const key = canonicalJson(value);
    const existing = this.referencePlaceholders.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const reference = placeholder(category, strategy);
    this.referencePlaceholders.set(key, reference);
    return reference;
  }

  async redactEvent(
    event: Readonly<EventEnvelope<string, unknown>>,
  ): Promise<EventEnvelope<string, unknown>> {
    const stateChangeResult =
      event.type === 'state.changed'
        ? await redactStateChangePayload(event.payload, this)
        : undefined;
    const protocolResult =
      stateChangeResult === undefined
        ? await redactProtocolEventPayload(event.payload, event.type, this)
        : undefined;
    const result =
      stateChangeResult ??
      protocolResult ??
      (await redactJsonValue(event.payload, this, {
        pathPrefix: '/payload',
        source: 'event',
        eventType: event.type,
      }));
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

  async redactCheckpoint(checkpoint: Readonly<Checkpoint>): Promise<Checkpoint> {
    if (isArtifactReference(checkpoint.state)) {
      return { ...checkpoint };
    }

    const result = await redactJsonValue(checkpoint.state, this, {
      pathPrefix: '/checkpoint/state',
      source: 'checkpoint',
    });
    if (!isRecord(result.value)) {
      throw new RedactionError(
        'UNSUPPORTED_VALUE',
        'Checkpoint redaction must preserve an object state.',
      );
    }

    const state = result.value as JsonObject;
    return {
      ...checkpoint,
      state,
      state_hash: hashState(state),
    };
  }

  asInterceptor(): RecorderInterceptor {
    return {
      beforeAppend: (event) => this.redactEvent(event),
      beforeCheckpoint: (checkpoint) => this.redactCheckpoint(checkpoint),
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
