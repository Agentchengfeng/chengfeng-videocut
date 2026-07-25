import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeProjectFileChanges } from "../utils/projectEvents";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback = typeof listener === "function"
      ? listener
      : (event: Event) => listener.handleEvent(event);
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (typeof listener === "function") this.listeners.get(type)?.delete(listener);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, event: Event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("shared Studio project events", () => {
  it("uses one EventSource for all file-change subscribers", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = subscribeProjectFileChanges(first);
    const unsubscribeSecond = subscribeProjectFileChanges(second);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/events");
    FakeEventSource.instances[0].emit("file-change", new Event("file-change"));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    vi.runAllTimers();
    expect(FakeEventSource.instances[0].closed).toBe(false);
    unsubscribeSecond();
    vi.runAllTimers();
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });
});
