// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/magic_test.go

import { describe, expect, test } from "bun:test";

import { shebang } from "@/tools/mimetype/internal/magic/magic";
import { CompactWS, FullWord } from "@/tools/mimetype/internal/scan/bytes";
import { raw } from "@test/tools/mimetype/go-literal";

const tests = [
  // Valid shebangs
  {
    name: "valid bash shebang",
    sig: "/bin/bash",
    input: "#!/bin/bash",
    flags: CompactWS,
    expected: true,
  },
  {
    name: "valid bash shebang with spaces",
    sig: "/bin/bash",
    input: "#! /bin/bash",
    flags: CompactWS,
    expected: true,
  },
  {
    // #762
    name: "valid bash shebang with multiple spaces",
    sig: "/bin/env bash",
    input: "#!   /bin/env  bash",
    flags: CompactWS | FullWord,
    expected: true,
  },
  {
    name: "valid bash shebang with tabs",
    sig: "/bin/bash",
    input: "#!\t/bin/bash",
    flags: CompactWS,
    expected: true,
  },
  {
    name: "valid bash shebang with mixed whitespace",
    sig: "/bin/bash",
    input: "#! \t /bin/bash",
    flags: CompactWS,
    expected: true,
  },
  {
    name: "valid bash shebang with trailing whitespace",
    sig: "/bin/bash",
    input: "#! /bin/bash \t ",
    flags: CompactWS,
    expected: true,
  },
  {
    name: "valid bash shebang with arguments",
    sig: "/bin/bash",
    input: "#!/bin/bash -exu",
    flags: CompactWS,
    expected: true,
  },
  {
    name: "valid env/python shebang",
    sig: "/usr/bin/env python",
    input: "#!/usr/bin/env python",
    flags: CompactWS,
    expected: true,
  },
  {
    name: "valid env/python shebang with spaces",
    sig: "/usr/bin/env python",
    input: "#! /usr/bin/env python",
    flags: CompactWS,
    expected: true,
  },
  {
    name: "valid env -S/python shebang with arguments",
    sig: "/usr/bin/env -S python",
    input: "#!/usr/bin/env -S python -u",
    flags: CompactWS,
    expected: true,
  },
  {
    name: "valid env/python shebang with arguments",
    sig: "/usr/bin/env python",
    input: "#!/usr/bin/env python -u",
    flags: CompactWS,
    expected: true,
  },
  {
    name: "valid env/python shebang with arguments and trailing ws",
    sig: "/usr/bin/env python",
    input: "#!/usr/bin/env python -u \n",
    flags: CompactWS,
    expected: true,
  },

  // Invalid shebangs
  {
    name: "missing shebang prefix",
    sig: "/bin/bash",
    input: "/bin/bash",
    flags: CompactWS,
    expected: false,
  },
  {
    name: "wrong shebang prefix",
    sig: "/bin/bash",
    input: "##!/bin/bash",
    flags: CompactWS,
    expected: false,
  },
  {
    name: "wrong shebang prefix 2",
    sig: "/bin/bash",
    input: "!#/bin/bash",
    flags: CompactWS,
    expected: false,
  },
  {
    name: "wrong interpreter path",
    sig: "/bin/bash",
    input: "#!/bin/sh",
    flags: CompactWS,
    expected: false,
  },
  {
    name: "partial interpreter path",
    sig: "/bin/bash",
    input: "#!/bin/bas",
    flags: CompactWS,
    expected: false,
  },
  {
    name: "extra characters after interpreter",
    sig: "/bin/bash",
    input: "#!/bin/bashx",
    flags: CompactWS,
    expected: true,
  },
  {
    name: "extra characters after interpreter but FullWord",
    sig: "/bin/bash",
    input: "#!/bin/bashx",
    flags: CompactWS | FullWord,
    expected: false,
  },
  {
    name: "extra characters after env interpreter",
    sig: "/usr/bin/env bash",
    input: "#!/usr/bin/env bash123",
    flags: CompactWS,
    expected: true,
  },
  {
    name: "extra characters after env interpreter but FullWord",
    sig: "/usr/bin/env bash",
    input: "#!/usr/bin/env bash123",
    flags: CompactWS | FullWord,
    expected: false,
  },

  // Edge cases
  {
    name: "empty input",
    sig: "/bin/bash",
    input: "",
    flags: CompactWS,
    expected: false,
  },
  {
    name: "too short input",
    sig: "/bin/bash",
    input: "#!",
    flags: CompactWS,
    expected: false,
  },
  {
    name: "just shebang prefix",
    sig: "/bin/bash",
    input: "#!",
    flags: CompactWS,
    expected: false,
  },
  {
    name: "shebang with only spaces",
    sig: "/bin/bash",
    input: "#!   ",
    flags: CompactWS,
    expected: false,
  },
  {
    name: "shebang with only tabs",
    sig: "/bin/bash",
    input: "#!\t\t",
    flags: CompactWS,
    expected: false,
  },
  {
    name: "empty signature",
    sig: "",
    input: "#!",
    flags: CompactWS,
    expected: true,
  },
  {
    name: "empty signature with spaces",
    sig: "",
    input: "#!   ",
    flags: CompactWS,
    expected: true,
  },
  {
    name: "signature longer than input",
    sig: "/very/long/path/to/interpreter",
    input: "#!/bin/bash",
    flags: CompactWS,
    expected: false,
  },
  {
    name: "case sensitivity test",
    sig: "/bin/bash",
    input: "#!/BIN/BASH",
    flags: CompactWS,
    expected: false,
  },
  {
    name: "case sensitivity test 2",
    sig: "/BIN/BASH",
    input: "#!/bin/bash",
    flags: CompactWS,
    expected: false,
  },
  {
    name: "case sensitivity test 2",
    sig: "/BIN/BASH",
    input: "#!/bin/bash",
    flags: CompactWS,
    expected: false,
  },
  {
    name: "shebang split in multiple lines",
    sig: "/bin/env bash",
    input: "#!/bin/env\nbash",
    flags: CompactWS | FullWord,
    expected: false,
  },
];

describe("TestShebangCheck", () => {
  for (const tt of tests) {
    test(tt.name, () => {
      const result = shebang(raw(tt.input), { sig: raw(tt.sig), flag: tt.flags });
      expect(result).toBe(tt.expected);
    });
  }
});
