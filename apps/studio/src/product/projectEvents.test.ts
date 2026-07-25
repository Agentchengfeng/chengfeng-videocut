import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProjectFileChangeHub,
  type ProjectFileChangeListener,
} from "./projectEvents";

class FakeEventSource {
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  closed = false;

  constructor(readonly url: string) {}

  addEventListener(type: "file-change", listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: "file-change", listener: (event: Event) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {
    this.closed = true;
  }

  emit(event: Event) {
    for (const listener of this.listeners.get("file-change") ?? []) listener(event);
  }
}

afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
});

describe("Product project file-change events", () => {
  it("shares one /api/events EventSource and closes it after the final subscriber", () => {
    vi.useFakeTimers();
    const sources: FakeEventSource[] = [];
    const hub = createProjectFileChangeHub({
      createEventSource: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source;
      },
    });
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = hub.subscribe(first);
    const unsubscribeSecond = hub.subscribe(second);

    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("/api/events");
    const event = new MessageEvent("file-change", { data: '{"path":"transcript.json"}' });
    sources[0].emit(event);
    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);

    unsubscribeFirst();
    vi.runAllTimers();
    expect(sources[0].closed).toBe(false);
    unsubscribeSecond();
    vi.runAllTimers();
    expect(sources[0].closed).toBe(true);
  });

  it("reuses the SSE connection across a StrictMode cleanup-remount probe", () => {
    vi.useFakeTimers();
    const sources: FakeEventSource[] = [];
    const hub = createProjectFileChangeHub({
      createEventSource: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source;
      },
    });

    hub.subscribe(vi.fn())();
    const unsubscribe = hub.subscribe(vi.fn());
    vi.runAllTimers();

    expect(sources).toHaveLength(1);
    expect(sources[0].closed).toBe(false);
    unsubscribe();
  });

  it("uses one Vite HMR listener and forwards hf:file-change payloads", () => {
    vi.useFakeTimers();
    let handler: ProjectFileChangeListener | null = null;
    const hot = {
      on: vi.fn((_event: "hf:file-change", listener: ProjectFileChangeListener) => {
        handler = listener;
      }),
      off: vi.fn(),
    };
    const createEventSource = vi.fn();
    const hub = createProjectFileChangeHub({ hot, createEventSource });
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = hub.subscribe(first);
    const unsubscribeSecond = hub.subscribe(second);
    const payload = { path: "edit-list.json", projectId: "project-a" };
    handler?.(payload);

    expect(hot.on).toHaveBeenCalledTimes(1);
    expect(createEventSource).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledWith(payload);
    expect(second).toHaveBeenCalledWith(payload);

    unsubscribeFirst();
    unsubscribeSecond();
    vi.runAllTimers();
    expect(hot.off).toHaveBeenCalledWith("hf:file-change", expect.any(Function));
  });
});
