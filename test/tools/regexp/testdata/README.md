# Go regexp test data

Copied unchanged from Go go1.27.2 `src/regexp/testdata` (see `LICENSE`).

- `re2-search.txt` and `re2-exhaustive.txt.bz2`: RE2's search and exhaustive test logs, built by running `make log` in the RE2 distribution (https://github.com/google/re2/). `exec.test.ts` runs all of `re2-search.txt`, and every 10th regexp of `re2-exhaustive.txt.bz2` (decompressed with `bzcat`); `RE2_EXHAUSTIVE=1` runs all 5.7 million exhaustive cases.
- `basic.dat`, `nullsubexpr.dat`, `repetition.dat`: AT&T POSIX test files (testregex by Glenn Fowler), edited by Go to reflect RE2/Go differences (marked 'RE2/Go' in the files).
