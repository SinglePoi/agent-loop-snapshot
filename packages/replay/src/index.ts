export const replayPackageName = '@agent-loop-snapshot/replay' as const;

export interface ReplayRunner {
  readonly packageName: typeof replayPackageName;
}

export * from './adapters.js';
export * from './correlation.js';
export * from './compiler.js';
export * from './mock.js';
export * from './policy.js';
export * from './recorded.js';
export * from './semantic.js';
export * from './scripted.js';
export * from './verified.js';
