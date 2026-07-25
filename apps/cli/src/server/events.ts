const encoder = new TextEncoder();
const KEEP_ALIVE_INTERVAL_MS = 5_000;

function encodeEvent(event: string | undefined, data: unknown): Uint8Array {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  const lines = payload.split(/\r?\n/).map((line) => `data: ${line}`);
  return encoder.encode(`${event ? `event: ${event}\n` : ""}${lines.join("\n")}\n\n`);
}

/** Small same-origin event hub shared by product API adapters and Studio clients. */
export class StudioEventHub {
  readonly #clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  readonly #keepAlive: ReturnType<typeof setInterval>;
  #closed = false;

  constructor() {
    // Bun's default HTTP idle timeout is 10 seconds. Keep the Studio event
    // stream active before that deadline so the client does not reconnect in a
    // loop while a long video is being reviewed.
    this.#keepAlive = setInterval(
      () => this.#broadcast(encoder.encode(": keepalive\n\n")),
      KEEP_ALIVE_INTERVAL_MS,
    );
    this.#keepAlive.unref?.();
  }

  response(): Response {
    let client: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        client = controller;
        if (this.#closed) {
          controller.close();
          return;
        }
        this.#clients.add(controller);
        controller.enqueue(encoder.encode(": connected\n\n"));
      },
      cancel: () => {
        if (client) this.#clients.delete(client);
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  }

  publish(event: string, data: unknown): void {
    this.#broadcast(encodeEvent(event, data));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#keepAlive);
    for (const client of this.#clients) {
      try {
        client.close();
      } catch {
        // A disconnected stream may already be closed.
      }
    }
    this.#clients.clear();
  }

  #broadcast(chunk: Uint8Array): void {
    for (const client of this.#clients) {
      try {
        client.enqueue(chunk);
      } catch {
        this.#clients.delete(client);
      }
    }
  }
}
