// The injected clock of the in-process rate limit tests: time only moves when
// a step's wait moves it.

import type { Clock } from "@/app/clock";

export function startClock(start: Date): Clock & { advance(ms: number): void } {
  let now = start.getTime();
  return {
    now: () => new Date(now),
    advance(ms) {
      now += ms;
    },
  };
}
