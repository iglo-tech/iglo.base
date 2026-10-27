// The clock every module reads the current time from. Upstream calls
// time.Now() directly; iglo.base injects it so tests never sleep.

export interface Clock {
  now(): Date;
}

export function systemClock(): Clock {
  return { now: () => new Date() };
}
