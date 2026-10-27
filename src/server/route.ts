// Upstream: tools/router/route.go

import type { Handler, HandlerFunc, Resolver } from "@/server/handler";

export class Route<T extends Resolver> {
  excludedMiddlewares: Set<string> | undefined;

  action: HandlerFunc<T>;
  method: string;
  path: string;
  middlewares: Handler<T>[] = [];

  constructor(method: string, path: string, action: HandlerFunc<T>) {
    this.method = method;
    this.path = path;
    this.action = action;
  }

  // BindFunc registers one or multiple middleware functions to the current route.
  //
  // The registered middleware functions are "anonymous" and with default priority,
  // aka. executes in the order they were registered.
  bindFunc(...middlewareFuncs: HandlerFunc<T>[]): this {
    for (const m of middlewareFuncs) {
      this.middlewares.push({ func: m });
    }
    return this;
  }

  // Bind registers one or multiple middleware handlers to the current route.
  bind(...middlewares: Handler<T>[]): this {
    this.middlewares.push(...middlewares);

    // unmark the newly added middlewares in case they were previously "excluded"
    if (this.excludedMiddlewares) {
      for (const m of middlewares) {
        if (m.id) {
          this.excludedMiddlewares.delete(m.id);
        }
      }
    }

    return this;
  }

  // Unbind removes one or more middlewares with the specified id(s) from the current route.
  //
  // It also adds the removed middleware ids to an exclude list so that they could be skipped from
  // the execution chain in case the middleware is registered in a parent group.
  //
  // Anonymous middlewares are considered non-removable, aka. this method
  // does nothing if the middleware id is an empty string.
  unbind(...middlewareIds: string[]): this {
    for (const middlewareId of middlewareIds) {
      if (middlewareId === "") {
        continue;
      }

      // remove from the route's middlewares
      this.middlewares = this.middlewares.filter((m) => m.id !== middlewareId);

      // add to the exclude list
      this.excludedMiddlewares ??= new Set();
      this.excludedMiddlewares.add(middlewareId);
    }

    return this;
  }
}
