#!/bin/sh
# Points git at the repository's hooks in .githooks (pre-commit formats staged files).
set -eu
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
echo "git hooks installed from .githooks"
