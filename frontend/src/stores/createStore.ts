import { create as createZustand, useStore } from "zustand";
import { createStore, type StateCreator, type StoreApi } from "zustand/vanilla";
import {
  unstable_cancelCallback as cancelCallback,
  unstable_NormalPriority as NormalPriority,
  unstable_scheduleCallback as scheduleCallback,
  type CallbackNode,
} from "scheduler";

export function scheduleStoreSubscription<T>(
  subscribe: StoreApi<T>["subscribe"],
): StoreApi<T>["subscribe"] {
  return (listener) => {
    let pending: CallbackNode | null = null;
    let active = true;
    let latest: T;
    let previous: T;
    const unsubscribe = subscribe((state, prevState) => {
      latest = state;
      if (pending) return;
      previous = prevState;
      pending = scheduleCallback(NormalPriority, () => {
        pending = null;
        if (active) listener(latest, previous);
      });
    });
    return () => {
      active = false;
      unsubscribe();
      if (pending) cancelCallback(pending);
      pending = null;
    };
  };
}

function createImpl<T>(initializer: StateCreator<T>) {
  const api = createStore(initializer);
  const reactApi = {
    ...api,
    subscribe: scheduleStoreSubscription(api.subscribe),
  };
  const useBoundStore = (selector: (state: T) => unknown = (state) => state) =>
    useStore(reactApi, selector);
  return Object.assign(useBoundStore, api);
}

export const create = ((initializer?: StateCreator<unknown>) =>
  initializer ? createImpl(initializer) : createImpl) as typeof createZustand;
