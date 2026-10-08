/**
 * Tells the open review pages that a session's human state changed, so a
 * write from an agent shows without a reload.
 */
export interface ReviewEvents {
  changed(sessionId: string): void;
  /** Returns the call that stops the subscription. */
  subscribe(sessionId: string, listener: () => void): () => void;
}

export function reviewEvents(): ReviewEvents {
  const listeners = new Map<string, Set<() => void>>();
  return {
    changed(sessionId) {
      for (const listener of listeners.get(sessionId) ?? []) listener();
    },
    subscribe(sessionId, listener) {
      let set = listeners.get(sessionId);
      if (!set) listeners.set(sessionId, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(sessionId);
      };
    },
  };
}
