// Upstream: tools/router/group.go
//
// (note: the class is named RouterGroup instead of Group so that it can
// be extended by the Router without conflicting with the group method)

import type { Handler, HandlerFunc, Resolver } from "@/server/handler";
import { Route } from "@/server/route";

// RouterGroup represents a collection of routes and other sub groups
// that share common pattern prefix and middlewares.
export class RouterGroup<T extends Resolver> {
  excludedMiddlewares: Set<string> | undefined;
  children: (RouterGroup<T> | Route<T>)[] = [];

  prefix = "";
  middlewares: Handler<T>[] = [];

  // Group creates and registers a new child group into the current one
  // with the specified prefix.
  //
  // The prefix follows the Go ServeMux pattern format ("[HOST]/[PATH]")
  // and is concatenated recursively into the final route path, meaning that
  // only the root level group could have HOST as part of the prefix.
  group(prefix: string): RouterGroup<T> {
    const newGroup = new RouterGroup<T>();
    newGroup.prefix = prefix;

    this.children.push(newGroup);

    return newGroup;
  }

  // BindFunc registers one or multiple middleware functions to the current group.
  //
  // The registered middleware functions are "anonymous" and with default priority,
  // aka. executes in the order they were registered.
  bindFunc(...middlewareFuncs: HandlerFunc<T>[]): this {
    for (const m of middlewareFuncs) {
      this.middlewares.push({ func: m });
    }
    return this;
  }

  // Bind registers one or multiple middleware handlers to the current group.
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

  // Unbind removes one or more middlewares with the specified id(s)
  // from the current group and its children (if any).
  //
  // Anonymous middlewares are not removable, aka. this method does nothing
  // if the middleware id is an empty string.
  unbind(...middlewareIds: string[]): this {
    for (const middlewareId of middlewareIds) {
      if (middlewareId === "") {
        continue;
      }

      // remove from the group middlewares
      this.middlewares = this.middlewares.filter((m) => m.id !== middlewareId);

      // remove from the group children
      for (const child of this.children) {
        child.unbind(middlewareId);
      }

      // add to the exclude list
      this.excludedMiddlewares ??= new Set();
      this.excludedMiddlewares.add(middlewareId);
    }

    return this;
  }

  // Route registers a single route into the current group.
  //
  // Note that the final route path will be the concatenation of all parent
  // groups prefixes + the route path. The path follows the Go ServeMux
  // format ("[HOST]/[PATH]"), meaning that only a top level group route
  // could have HOST as part of the prefix.
  //
  // Returns the newly created route to allow attaching route-only middlewares.
  route(method: string, path: string, action: HandlerFunc<T>): Route<T> {
    const route = new Route<T>(method, path, action);
    this.children.push(route);
    return route;
  }

  // Any is a shorthand for route with "" as route method (aka. matches any method).
  any(path: string, action: HandlerFunc<T>): Route<T> {
    return this.route("", path, action);
  }

  GET(path: string, action: HandlerFunc<T>): Route<T> {
    return this.route("GET", path, action);
  }

  SEARCH(path: string, action: HandlerFunc<T>): Route<T> {
    return this.route("SEARCH", path, action);
  }

  POST(path: string, action: HandlerFunc<T>): Route<T> {
    return this.route("POST", path, action);
  }

  DELETE(path: string, action: HandlerFunc<T>): Route<T> {
    return this.route("DELETE", path, action);
  }

  PATCH(path: string, action: HandlerFunc<T>): Route<T> {
    return this.route("PATCH", path, action);
  }

  PUT(path: string, action: HandlerFunc<T>): Route<T> {
    return this.route("PUT", path, action);
  }

  HEAD(path: string, action: HandlerFunc<T>): Route<T> {
    return this.route("HEAD", path, action);
  }

  OPTIONS(path: string, action: HandlerFunc<T>): Route<T> {
    return this.route("OPTIONS", path, action);
  }

  // HasRoute checks whether the specified route pattern (method + path)
  // is registered in the current group or its children.
  //
  // Note that routes with anonymous and named wildcard placeholder are treated as equal,
  // aka. "GET /abc/" is considered the same as "GET /abc/{something...}".
  hasRoute(method: string, path: string): boolean {
    let pattern = path;
    if (method !== "") {
      pattern = `${method.toUpperCase()} ${pattern}`;
    }
    return this.#hasRoute(pattern, []);
  }

  #hasRoute(pattern: string, parents: RouterGroup<T>[]): boolean {
    for (const child of this.children) {
      if (child instanceof RouterGroup) {
        if (child.#hasRoute(pattern, [...parents, this])) {
          return true;
        }
        continue;
      }

      let result = "";
      if (child.method !== "") {
        result += `${child.method} `;
      }
      // add parent groups prefixes
      for (const p of parents) {
        result += p.prefix;
      }
      // add current group prefix
      result += this.prefix;
      // add current route path
      result += child.path;

      if (
        result === pattern || // direct match
        // compares without the named wildcard, aka. /abc/{test...} is equal to /abc/
        stripWildcard(result) === stripWildcard(pattern)
      ) {
        return true;
      }
    }
    return false;
  }
}

const wildcardPlaceholderRegex = /\/{.+\.\.\.}$/;

function stripWildcard(pattern: string): string {
  return pattern.replace(wildcardPlaceholderRegex, "/");
}
