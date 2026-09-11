interface AsyncIteratorLike {
  next(...args: readonly unknown[]): Promise<IteratorResult<unknown>>;
  return?(value?: unknown): Promise<IteratorResult<unknown>>;
  throw?(error?: unknown): Promise<IteratorResult<unknown>>;
}

/**
 * Installs a one-shot observer on an SDK stream without advancing it. The
 * supplied callbacks are invoked only as the stream's consumer advances,
 * cancels, or observes an error.
 */
export function observeSdkStream(
  stream: unknown,
  onComplete: (eventCount: number, lastEvent: unknown) => Promise<void>,
  onFailure: (error: unknown) => Promise<void>,
  onEarlyEnd: () => Promise<void>,
): Promise<void> {
  if (typeof stream !== 'object' || stream === null) {
    return Promise.reject(new Error('SDK declared a stream but did not return an object.'));
  }
  const target = stream as { [Symbol.asyncIterator]?: () => AsyncIteratorLike };
  const original = target[Symbol.asyncIterator];
  if (typeof original !== 'function') {
    return Promise.reject(new Error('SDK declared a stream but returned no async iterator.'));
  }
  const descriptor = Object.getOwnPropertyDescriptor(target, Symbol.asyncIterator);
  let settled = false;
  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let count = 0;
  let lastEvent: unknown = undefined;
  const finish = (action: () => Promise<void>): void => {
    if (settled) return;
    settled = true;
    void action()
      .catch(() => undefined)
      .finally(() => {
        if (Object.getOwnPropertyDescriptor(target, Symbol.asyncIterator)?.value === replacement) {
          if (descriptor === undefined) delete target[Symbol.asyncIterator];
          else Object.defineProperty(target, Symbol.asyncIterator, descriptor);
        }
        resolveDone?.();
      });
  };
  const replacement = function (this: unknown): AsyncIteratorLike {
    const iterator = original.call(this);
    return {
      async next(...args: readonly unknown[]): Promise<IteratorResult<unknown>> {
        try {
          const step = await iterator.next(...args);
          if (step.done) finish(() => onComplete(count, lastEvent));
          else {
            count += 1;
            lastEvent = step.value;
          }
          return step;
        } catch (error) {
          finish(() => onFailure(error));
          throw error;
        }
      },
      async return(value?: unknown): Promise<IteratorResult<unknown>> {
        try {
          const result =
            iterator.return === undefined ? { done: true, value } : await iterator.return(value);
          finish(onEarlyEnd);
          return result;
        } catch (error) {
          finish(() => onFailure(error));
          throw error;
        }
      },
      async throw(error?: unknown): Promise<IteratorResult<unknown>> {
        try {
          if (iterator.throw === undefined) throw error;
          const result = await iterator.throw(error);
          finish(() => onFailure(error));
          return result;
        } catch (caught) {
          finish(() => onFailure(caught));
          throw caught;
        }
      },
    };
  };
  Object.defineProperty(target, Symbol.asyncIterator, { configurable: true, value: replacement });
  return done;
}
