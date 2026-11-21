/**
 * Shared AbortSignal helpers for LLM requests, web search providers, and bounded image resolution.
 */

export function combineAbortSignals(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timeoutId = null;

  const onParentAbort = () => {
    controller.abort(parentSignal?.reason || new DOMException('Request aborted', 'AbortError'));
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason || new DOMException('Request aborted', 'AbortError'));
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      controller.abort(new DOMException(`Operation timed out after ${timeoutMs}ms`, 'TimeoutError'));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    controller,
    cleanup: () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
    }
  };
}

export function raceWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(signal.reason || new DOMException('Request aborted', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason || new DOMException('Request aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    Promise.resolve(promise).then(
      (val) => {
        signal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason || new DOMException('Request aborted', 'AbortError');
  }
}
