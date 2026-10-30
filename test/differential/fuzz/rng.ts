// The fuzzer's random numbers. Each case has its own stream, derived from the
// run's seed and the case number, so one case replays without the others.

function mix(h: number): number {
  let x = h;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

export class Rng {
  private state: number;

  constructor(seed: number, stream: number) {
    this.state = mix(mix(seed | 0) ^ mix((stream * 0x9e3779b1) | 0));
  }

  // mulberry32
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(max: number): number {
    return Math.floor(this.next() * max);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error("pick from an empty list");
    }
    return items[this.int(items.length)] as T;
  }

  weighted<T>(items: readonly (readonly [T, number])[]): T {
    let left = this.next() * items.reduce((sum, [, weight]) => sum + weight, 0);
    for (const [item, weight] of items) {
      left -= weight;
      if (left < 0) {
        return item;
      }
    }
    return (items[items.length - 1] as readonly [T, number])[0];
  }
}
