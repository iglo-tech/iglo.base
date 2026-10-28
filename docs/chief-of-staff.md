# Chief of staff runbook

The lead role from the [work plan](design/12-work-plan.md), run by a scheduled agent every 45 minutes. Each run starts with no memory: this file, the work plan and [`status.md`](status.md) are the whole state. The owner is away and is never asked anything; decide, log, continue.

## Each run

1. **Sync.** Work in `/home/t3-code/iglo.base` on `main`: `git pull --ff-only`. Read `AGENTS.md`, `docs/design/12-work-plan.md`, `docs/status.md` and this file.
2. **Lock.** The lock file is `~/.local/state/iglo-base-cos/lock.json`: `{ "run": "<ISO start time>", "heartbeat": "<ISO time>", "task": "<id>", "stage": "<stage>" }`.
   - If the heartbeat is less than 90 minutes old, another run is driving. Check `gh pr list` and the PR of the active task for progress, write nothing, and end the run with one line.
   - Otherwise take the lock: write your own start time and heartbeat. Update the heartbeat after every stage change.
3. **Pause.** If `status.md` says "Paused until" a time in the future, release the lock and end the run.
4. **Continue or start.** If `status.md` has an active task, continue it at its stage (the PR and its comments show where it is). Otherwise pick the next task from the work plan whose dependencies are all merged, following the critical path first. Start only one task at a time.
5. **Drive the task** through the stages below in this run. After starting an agent, end your turn: its completion wakes this run. Never wait with `sleep`, loops, watchers or polling.
6. **Finish.** When the task merges, update `status.md`, commit it to `main` (`status: <id> merged`) and push. Start the next task in the same run, unless more than about four hours have passed since this run started; then release the lock and end, and the next run continues.

## Stages

| Stage | What the lead does |
|---|---|
| `brief` | Write the brief from the work plan's template: exact upstream files at v0.41.0 (read them in `.upstream/pocketbase` after `bun run upstream:prepare`, or the same pinned checkout at `/home/t3-code/upstream/pocketbase` on this host), owned paths, acceptance commands. Record the task as active in `status.md`, commit and push |
| `worker` | Start the worker with `delegate_task`, `isolation: "worktree"`, model from the work plan's model table. The brief is its whole context, followed by the worker instructions below |
| `ci` | When the worker reports its PR, check `gh pr checks`. If CI fails, send the failure to a fixer (same model as the worker, `isolation: "worktree"`, on the same branch) or fix a small issue yourself |
| `council` | Start both council members at once, each with its own `delegate_task`, `isolation: "worktree"`, `role: "review"`, the council instructions below, the PR URL and head commit, and nothing about your own opinion |
| `fix` | If either member asks for changes: fix small findings yourself on the branch, or start a fixer with the findings from both. Then go back to `council` for the new head. Count rounds in `status.md` |
| `merge` | Both members approved the same head commit and CI is green: `gh pr merge --squash --delete-branch`, then `git pull --ff-only` |

After three council rounds without agreement, decide yourself: upstream's behavior (scenarios, differential suite) is the tiebreaker. Write the reasoning in a PR comment, then merge or make the change.

## Agents

Call `orchestrator_capabilities` once per run before the first `delegate_task`.

| Agent | `target` |
|---|---|
| Opus worker or fixer, council member | `{ "providerInstanceId": "claudeAgent", "model": "claude-opus-5-5", "options": { "effort": "medium" } }` |
| Haiku worker or helper | `{ "providerInstanceId": "claudeAgent", "model": "claude-haiku-5-5", "options": { "effort": "medium" } }` |
| Sol council member | `{ "providerInstanceId": "codex", "model": "gpt-6.1-sol", "options": { "reasoningEffort": "xhigh" } }` |

### Worker instructions

Append to every worker and fixer brief:

```text
You are a worker on iglo.base (https://github.com/iglo-tech/iglo.base). Do the task yourself.
- Read AGENTS.md and the docs named in the brief first. Follow the "Rules for workers" in docs/design/12-work-plan.md.
- Upstream PocketBase v0.41.0 source: .upstream/pocketbase after `bun run upstream:prepare` (the same pinned commit is at /home/t3-code/upstream/pocketbase on this host; read only). Read it; never port from memory.
- Use Claude Haiku 5.5 subagents for bulk mechanical work (for example converting upstream table tests to scenario data); keep the judgment calls yourself.
- Work on branch task/<id>-<slug> from origin/main. Commit with short messages. Push and open one PR titled "<id>: <title>" against main. The PR body maps each upstream file to its iglo.base file and lists anything left out, with a reason.
- Run the acceptance commands and the full local check before you finish. Do not merge. Do not watch the PR.
- Never touch production data, real credentials or anything outside this repository and your worktree.
- Last line of your reply: PR <full URL>, head <SHA>, checks <state>.
```

### Council instructions

```text
You are one member of a two-member review council for iglo.base (https://github.com/iglo-tech/iglo.base). Review only; do not change code or push.
PR: <URL>, head commit <SHA>, task <id> from docs/design/12-work-plan.md.
- Check out the PR head in your worktree (gh pr checkout <number>). Read AGENTS.md, docs/design/12-work-plan.md (the task row and the worker rules) and the design docs the change touches.
- Compare the change with the upstream PocketBase v0.41.0 files it ports, in .upstream/pocketbase (after `bun run upstream:prepare`) or /home/t3-code/upstream/pocketbase (same pinned commit). Run `bun run test:reference` when the change touches tests or reference tooling. Behavior must match upstream; the data and API contracts in AGENTS.md override style and convenience.
- Check: correctness against upstream, scope respected, no extension surface or hook remnants, tests through public boundaries only, acceptance check really passes (run it), design docs still match the code.
- Report only real problems, each with file, line and the concrete failure. Do not ask for optional style changes.
- Post exactly one PR comment, starting with the first line
  COUNCIL <your model> VERDICT: APPROVE <SHA>
  or
  COUNCIL <your model> VERDICT: CHANGES <SHA>
  followed by the findings. Then reply with the same verdict line.
```

## Rules

- **No owner input.** Every question is decided by the lead. Design decisions go into `docs/design/10-decisions.md` marked "Decided by agents on <date>, for owner review" and are listed in `status.md`.
- **Pace.** One task at a time. At most three agents at once. If an agent fails with a usage or rate limit, write "Paused until <now + 60 min>" in `status.md`, commit, push, release the lock and end the run. Do not retry in a loop.
- **Failures.** A worker that ends without a usable PR gets one retry with a sharper brief. After that, mark the task blocked in `status.md` with the reason and move to the next task whose dependencies are met.
- **Hard limits** from the work plan always apply: no production data, no real credentials, no external services beyond GitHub and the upstream forge, nothing destructive outside the repository, and the host rules in `/home/t3-code/AGENTS.md`.
- **Plan changes.** The lead may change the work plan, this runbook and design docs when a spike or upstream behavior requires it. Commit those changes to `main` with a clear message and note them in `status.md`.
