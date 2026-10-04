import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { persist, createJSONStorage } from 'zustand/middleware';
import { create, scheduleStoreSubscription } from './createStore';

const scheduler = vi.hoisted(() => ({ callbacks: new Map<object, () => void>() }));
vi.mock('scheduler', () => ({
  unstable_NormalPriority: 3,
  unstable_scheduleCallback: (_priority: number, callback: () => void) => {
    const node = {};
    scheduler.callbacks.set(node, callback);
    return node;
  },
  unstable_cancelCallback: (node: object) => scheduler.callbacks.delete(node),
}));

function flushScheduler() {
  const callbacks = [...scheduler.callbacks.values()];
  scheduler.callbacks.clear();
  callbacks.forEach((callback) => callback());
}

describe('React store notification scheduling', () => {
  beforeEach(() => scheduler.callbacks.clear());

  it('keeps state and imperative subscribers synchronous, coalesces React notifications until the scheduler resumes', () => {
    const store = createStore(() => ({ value: 0 }));
    const imperative = vi.fn();
    const react = vi.fn();
    store.subscribe(imperative);
    const unsubscribe = scheduleStoreSubscription(store.subscribe)(react);
    for (let i = 1; i <= 150; i++) store.setState({ value: i });
    expect(store.getState().value).toBe(150);
    expect(imperative).toHaveBeenCalledTimes(150);
    expect(react).not.toHaveBeenCalled();
    expect(scheduler.callbacks.size).toBe(1);
    flushScheduler();
    expect(react).toHaveBeenCalledExactlyOnceWith({ value: 150 }, { value: 0 });
    unsubscribe();
  });

  it('cancels pending work on unmount and does not notify an old StrictMode subscription', () => {
    const store = createStore(() => ({ value: 0 }));
    const first = vi.fn();
    const subscribe = scheduleStoreSubscription(store.subscribe);
    const unsubscribe = subscribe(first);
    store.setState({ value: 1 });
    unsubscribe();
    expect(scheduler.callbacks.size).toBe(0);
    const second = vi.fn();
    const unsubscribeSecond = subscribe(second);
    store.setState({ value: 2 });
    flushScheduler();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith({ value: 2 }, { value: 1 });
    unsubscribeSecond();
  });

  it('schedules a later update separately when a subscriber changes state during delivery', () => {
    const store = createStore(() => ({ value: 0 }));
    const listener = vi.fn((state: { value: number }) => {
      if (state.value === 1) store.setState({ value: 2 });
    });
    const unsubscribe = scheduleStoreSubscription(store.subscribe)(listener);
    store.setState({ value: 1 });
    flushScheduler();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(scheduler.callbacks.size).toBe(1);
    flushScheduler();
    expect(listener).toHaveBeenLastCalledWith({ value: 2 }, { value: 1 });
    unsubscribe();
  });

  it('preserves the curried factory and persist API without deferring storage', () => {
    const values = new Map<string, string>();
    const store = create<{ value: number }>()(
      persist(() => ({ value: 0 }), {
        name: 'test',
        storage: createJSONStorage(() => ({
          getItem: (key) => values.get(key) ?? null,
          setItem: (key, value) => {
            values.set(key, value);
          },
          removeItem: (key) => {
            values.delete(key);
          },
        })),
      }),
    );
    store.setState({ value: 2 });
    expect(store.getState().value).toBe(2);
    expect(JSON.parse(values.get('test')!).state.value).toBe(2);
    expect(store.persist.hasHydrated()).toBe(true);
  });
});
