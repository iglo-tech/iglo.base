// A test-only EventSource on fetch. The JavaScript SDK's realtime service
// uses the global EventSource, which Bun does not have. installEventSource()
// sets the global; the SDK only uses the constructor, addEventListener,
// removeEventListener, onerror and close(), and reads `data` and
// `lastEventId` of the events.

export interface SseMessage {
  type: string;
  data: string;
  lastEventId: string;
}

type Listener = (event: SseMessage) => void;

export class FetchEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readyState = 0;
  onerror: ((event: { type: string }) => void) | null = null;
  onopen: ((event: { type: string }) => void) | null = null;
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #abort = new AbortController();

  constructor(readonly url: string) {
    void this.#run();
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(listener);
    this.#listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = 2;
    this.#abort.abort();
  }

  async #run(): Promise<void> {
    try {
      const res = await fetch(this.url, {
        headers: { Accept: "text/event-stream", "Cache-Control": "no-store" },
        signal: this.#abort.signal,
      });
      if (res.status !== 200 || res.body === null) {
        throw new Error(`status ${res.status}`);
      }
      this.readyState = 1;
      this.onopen?.({ type: "open" });
      const decoder = new TextDecoder();
      let buffer = "";
      let event = { type: "message", data: "", lastEventId: "" };
      let lastId = "";
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        for (;;) {
          const match = /\r\n|\n|\r/.exec(buffer);
          if (match === null) {
            break;
          }
          const line = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          if (line === "") {
            if (event.data !== "") {
              this.#dispatch({
                ...event,
                data: event.data.replace(/\n$/, ""),
                lastEventId: lastId,
              });
            }
            event = { type: "message", data: "", lastEventId: "" };
          } else if (!line.startsWith(":")) {
            const colon = line.indexOf(":");
            const field = colon === -1 ? line : line.slice(0, colon);
            const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
            if (field === "event") {
              event.type = value;
            } else if (field === "data") {
              event.data += `${value}\n`;
            } else if (field === "id") {
              lastId = value;
            }
          }
        }
      }
      throw new Error("stream ended");
    } catch {
      if (this.readyState !== 2) {
        this.readyState = 2;
        this.onerror?.({ type: "error" });
      }
    }
  }

  #dispatch(message: SseMessage): void {
    for (const listener of this.#listeners.get(message.type) ?? []) {
      listener(message);
    }
  }
}

export function installEventSource(): void {
  (globalThis as { EventSource?: unknown }).EventSource ??= FetchEventSource;
}
