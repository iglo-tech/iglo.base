// Upstream: tools/hook/hook.go and tools/hook/event.go (Handler, the
// priority-ordered Bind and the Trigger chain only).
//
// This is the router's internal middleware chain, not an event hook system:
// there is no public registration API (AGENTS.md "No extension surface").
//
// Handlers follow Go's error convention: an error is returned (or resolved),
// never thrown. A thrown exception is the equivalent of a Go panic and is
// turned into a 500 response by the panicRecover middleware.

// What a handler returns: undefined on success, or the error.
export type HandlerResult = Error | undefined | void;

export type HandlerFunc<T> = (e: T) => HandlerResult | Promise<HandlerResult>;

// Handler defines a single middleware handler.
export interface Handler<T> {
  // Func defines the handler function to execute. It must call e.next()
  // to proceed with the chain.
  func: HandlerFunc<T>;
  // Id is the unique identifier of the handler. Empty for anonymous handlers.
  id?: string;
  // Priority changes the default exec priority of the handler within a chain.
  // If 0, the handler is executed in the order it was registered.
  priority?: number;
}

// Resolver is the base of every chain event (hook.Event).
export class Resolver {
  #next: (() => Promise<HandlerResult>) | undefined;

  // Next calls the next handler in the chain (if any).
  next(): Promise<HandlerResult> {
    return this.#next ? this.#next() : Promise.resolve(undefined);
  }

  // used only by Chain.trigger
  setNextFunc(f: (() => Promise<HandlerResult>) | undefined): void {
    this.#next = f;
  }

  nextFunc(): (() => Promise<HandlerResult>) | undefined {
    return this.#next;
  }
}

// Chain is the ordered handler list of a single route (hook.Hook).
export class Chain<T extends Resolver> {
  #handlers: { handler: Handler<T>; key: string }[] = [];
  #anonymous = 0;

  // Bind registers the handler. A handler with the same non-empty id as an
  // existing one replaces it in place. Handlers are kept sorted by priority,
  // preserving the registration order of equal priorities.
  bind(handler: Handler<T>): void {
    const id = handler.id ?? "";
    let key: string;
    if (id === "") {
      // hook.Bind assigns a random id; a counter is equivalent here
      key = `\0anonymous${this.#anonymous++}`;
    } else {
      key = id;
      const existing = this.#handlers.findIndex((h) => h.key === key);
      if (existing !== -1) {
        this.#handlers[existing] = { handler, key };
        this.#sort();
        return;
      }
    }
    this.#handlers.push({ handler, key });
    this.#sort();
  }

  // Unbind removes the handlers with the given ids.
  unbind(...ids: string[]): void {
    for (const id of ids) {
      const i = this.#handlers.findLastIndex((h) => h.key === id);
      if (i !== -1) {
        this.#handlers.splice(i, 1);
      }
    }
  }

  length(): number {
    return this.#handlers.length;
  }

  // Trigger executes the handlers one by one with the event, followed by the
  // one-off handlers. Each handler must call event.next() to continue.
  trigger(event: T, ...oneOffHandlerFuncs: HandlerFunc<T>[]): Promise<HandlerResult> {
    const funcs = [...this.#handlers.map((h) => h.handler.func), ...oneOffHandlerFuncs];

    event.setNextFunc(undefined); // reset in case the event is being reused

    for (let i = funcs.length - 1; i >= 0; i--) {
      const func = funcs[i] as HandlerFunc<T>;
      const old = event.nextFunc();
      event.setNextFunc(async () => {
        event.setNextFunc(old);
        return func(event);
      });
    }

    return event.next();
  }

  #sort(): void {
    // Array.prototype.sort is stable, as sort.SliceStable
    this.#handlers.sort((a, b) => (a.handler.priority ?? 0) - (b.handler.priority ?? 0));
  }
}
