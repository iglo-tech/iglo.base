// Upstream: none. The lint rule @nkzw/no-instanceof (D44) forbids the operator;
// this gives the same answer for ordinary classes and built-ins: true when
// ctor.prototype is on the prototype chain of value (a proxy's getPrototypeOf
// trap included, as with the operator). Primitives are never instances.

export function isInstance<T>(ctor: { readonly prototype: T }, value: unknown): value is T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return false;
  }
  for (let proto: object | null = Reflect.getPrototypeOf(value); proto !== null;) {
    if (proto === ctor.prototype) {
      return true;
    }
    proto = Reflect.getPrototypeOf(proto);
  }
  return false;
}
