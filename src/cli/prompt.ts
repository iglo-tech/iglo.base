// Upstream: tools/osutils/cmd.go (YesNoPrompt)
//
// Without a terminal the read ends at once, which answers the fallback.

import { readSync } from "node:fs";

import { toLower, trimSpace } from "@/collections/go-strings";

// a line of standard input, without waiting for more than the line
function readLine(): string {
  const bytes: number[] = [];
  const buffer = new Uint8Array(1);
  for (;;) {
    let read = 0;
    try {
      read = readSync(0, buffer, 0, 1, null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EAGAIN") {
        Bun.sleepSync(10);
        continue;
      }
      read = 0; // a closed stdin is the end of the input
    }
    if (read === 0) {
      return new TextDecoder().decode(new Uint8Array(bytes));
    }
    const byte = buffer[0] as number;
    bytes.push(byte);
    if (byte === 0x0a) {
      return new TextDecoder().decode(new Uint8Array(bytes));
    }
  }
}

// YesNoPrompt asks on standard error; an empty answer is the fallback.
export function yesNoPrompt(
  stderr: (text: string) => void,
  message: string,
  fallback: boolean,
  read: () => string = readLine,
): boolean {
  const options = fallback ? "Y/n" : "y/N";

  for (;;) {
    stderr(`${message} (${options}) `);

    switch (toLower(trimSpace(read()))) {
      case "":
        return fallback;
      case "y":
      case "yes":
        return true;
      case "n":
      case "no":
        return false;
    }
  }
}
