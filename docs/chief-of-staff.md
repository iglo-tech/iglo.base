# Chief of staff runbook

The lead role from the [work plan](design/12-work-plan.md), run by a scheduled agent every 45 minutes. Each run starts with no memory: this file, the work plan and [`status.md`](status.md) are the whole state. The owner is away and is never asked anything; decide, log, continue.

## Each run

1. **Sync.** Work in `/home/t3-code/iglo.base` on `main`: `git pull --ff-only`. Read `AGENTS.md`, `docs/design/12-work-plan.md`, `docs/status.md` and this file.
2. **Lock.** The lock file is `~/.local/state/iglo-base-cos/lock.json`: `{ "run": "<ISO start time>", "heartbeat": "<ISO time>", "task": "<id>", "stage": "<stage>", "leadThread": "<T3 thread id of the run holding the lock>", "agentThreads": ["<T3 thread id of each running worker, fixer or reviewer>"] }`.
   - **Verify the actual work, never files alone.** The lock, file timestamps, branches and processes are hints, not proof. Look up the threads with `t3_thread_list` (`allProjects`, `includeSubagents`; match the lock's thread ids, or titles with the task id) and `t3_thread_read` (`view: "activity"`, a small `limit`, `runLimit: 2`). Record for the lead thread and each agent thread: status, latest run status and time, the last activity item, and any usage-limit or error item.
   - The lock is held only if the lock's lead thread is `running` (or `waiting` on its agents) and the heartbeat is less than 90 minutes old. Then write nothing and end the run with one line naming both threads by their `link` and what each is doing.
   - Otherwise the lock is abandoned, even with a fresh heartbeat (for example a lead that failed on a usage limit while its worker runs on). Take it: write your own start time, heartbeat and thread id, and adopt the running agent threads. Do not start a duplicate agent for work a live thread is doing. An adopted agent's completion goes to the dead lead, not to you, so check it again in your next run (or now if it has finished) and read its final result with `t3_thread_read`. A failed agent thread with no live run gets the retry from Rules → Failures.
   - Update the heartbeat after every stage change, and the thread ids whenever you start or adopt an agent.
3. **Pause.** If `status.md` says "Paused until" a time in the future, release the lock and end the run.
4. **Continue or start.** If `status.md` has an active task, continue it at its stage (the PR and its comments show where it is). Otherwise pick the next task from the work plan whose dependencies are all merged, following the critical path first. Start only one task at a time.
5. **Drive the task** through the stages below in this run. After starting an agent, end your turn: its completion wakes this run. Never wait with `sleep`, loops, watchers or polling.
6. **Finish.** When the task merges, update `status.md`, commit it to `main` (`status: <id> merged`) and push. Start the next task in the same run, unless more than about four hours have passed since this run started; then release the lock and end, and the next run continues.

## Stages

| Stage | What the lead does |
|---|---|
| `brief` | Write the brief from the work plan's template: exact upstream files at v0.41.0 (read them in `.upstream/pocketbase` after `bun run upstream:prepare`, or the same pinned checkout at `/home/t3-code/upstream/pocketbase` on this host), owned paths, acceptance commands. Record the task as active in `status.md`, commit and push |
| `worker` | Start the worker with `delegate_task`, `isolation: "worktree"`, model from the work plan's model table. The brief is its whole context, followed by the worker instructions below |
| `review` | When the worker reports its PR with the local check and `test:reference` passing, start the reviewer (`delegate_task`, `isolation: "worktree"`, `role: "review"`) with the reviewer instructions below, the PR URL and head commit, and nothing about your own opinion. CI is not waited for (D25) |
| `fix` | Judge every finding yourself (the council is you and the reviewer, D25). Agree: for each finding, find its whole class first (the same mistake on sibling paths, inputs and fields) so the next round does not find the next instance; fix small ones yourself on the branch (run the affected tests, then `bun run check` and `bun run test:reference` once), or start one fixer with all of them and the instruction to fix each finding's whole class. Disagree: answer in a PR comment with upstream's behavior and D26 as the reference. Exotic-input findings that are handled safely go to the hardening backlog in `status.md`. Then start a re-review of the new head: the fixes and the code they touch. Count rounds in `status.md` |
| `merge` | The reviewer approved the head, or you and the reviewer agree that what remains is backlog, and the local check passed on that head: `gh pr merge --squash --delete-branch`, then `git pull --ff-only` |

After three council rounds without agreement, decide yourself: upstream's behavior (scenarios, differential suite) is the tiebreaker. Write the reasoning in a PR comment, then merge or make the change.

## Agents

Call `orchestrator_capabilities` once per run before the first `delegate_task`.

| Agent | `target` |
|---|---|
| Opus worker or fixer (never a reviewer) | `{ "providerInstanceId": "claudeAgent", "model": "claude-opus-5-5", "options": { "effort": "medium" } }` |
| Haiku worker or helper | `{ "providerInstanceId": "claudeAgent", "model": "claude-haiku-5-5", "options": { "effort": "medium" } }` |
| Sol reviewer | `{ "providerInstanceId": "codex", "model": "gpt-6.1-sol", "options": { "reasoningEffort": "xhigh" } }` |

### Worker instructions

Append to every worker and fixer brief:

```text
You are a worker on iglo.base (https://github.com/iglo-tech/iglo.base). Do the task yourself.
- Read AGENTS.md and the docs named in the brief first. Follow the "Rules for workers" in docs/design/12-work-plan.md.
- Upstream PocketBase v0.41.0 source: .upstream/pocketbase after `bun run upstream:prepare` (the same pinned commit is at /home/t3-code/upstream/pocketbase on this host; read only). Read it; never port from memory.
- Use Claude Haiku 5.5 subagents for bulk mechanical work (for example converting upstream table tests to scenario data); keep the judgment calls yourself.
- Work on branch task/<id>-<slug> from origin/main. Commit with short messages. Push and open one PR titled "<id>: <title>" against main. The PR body maps each upstream file to its iglo.base file and lists anything left out, with a reason.
- Run the acceptance commands and the full local check (`bun run check`, then `bun run test:reference`, never in parallel: the host has limited memory) before you finish, in the foreground. Do not end your turn while a check runs in the background. CI is not used. Do not merge. Do not watch the PR.
- A fixer fixes each finding's whole class: search for the same mistake on sibling code paths, inputs and fields before pushing, and say in the PR comment what was checked.
- Before your final reply, delete `dist/` and any temporary data you created in your worktree (the host disk is small; `.upstream` is a shared cache, leave it).
- Never put `rm` with a glob, a variable or a command substitution in a shell command: it raises a permission prompt nobody can answer, and the run stalls for good. Give each probe a new `mktemp -d` directory; at the end delete it by its literal absolute path, in a call of its own.
- Match upstream's results, not its implementation (AGENTS.md, D26): port upstream logic where the result depends on it, use Bun and Web APIs where they give the same results for real client requests.
- Never touch production data, real credentials or anything outside this repository and your worktree.
- Last line of your reply: PR <full URL>, head <SHA>, local checks <state>.
```

### Reviewer instructions

```text
You are the reviewer for iglo.base (https://github.com/iglo-tech/iglo.base); the lead (chief of staff) and you form the council, and a PR merges when you both agree. Review only; do not change code or push.
PR: <URL>, head commit <SHA>, task <id> from docs/design/12-work-plan.md (brief: docs/briefs/<id>.md). Round <n>.
- Check out the PR head in your worktree (gh pr checkout <number>, or a detached checkout of the head). Read AGENTS.md, docs/design/12-work-plan.md (the task row and the worker rules), D25 and D26 in docs/design/10-decisions.md and the design docs the change touches.
- Round 1: review deeply. Compare the change with the upstream PocketBase v0.41.0 files it ports, in .upstream/pocketbase (after `bun run upstream:prepare`) or /home/t3-code/upstream/pocketbase (same pinned commit), and probe both servers. Later rounds: verify that each earlier finding is fixed and review the code the fixes touch; do not re-review the whole PR.
- Run `bun run check` and then `bun run test:reference` locally (one after the other; the host has limited memory; never write into tracked fixtures). CI is not used. Before your final reply, delete `dist/` and any temporary data you created.
- Check: results match upstream for the requests real clients send, the data contract, rules and auth, scope respected, no extension surface or hook remnants, tests through public boundaries only, design docs match the code.
- When you find a defect, look for its whole class (the same mistake on sibling code paths, inputs and fields) and report every instance in this round, so fixes do not trickle in over several rounds.
- A blocking finding names the file and line, the realistic client and request, and the concrete failure. Malformed or hand-crafted input that is handled safely (no crash, no partial data, no rule bypass, bounded memory) but answered differently from upstream is not blocking (D26): list it under "Backlog". No optional style changes.
- Post exactly one PR comment, starting with the first line
  COUNCIL <your model> VERDICT: APPROVE <SHA>
  or
  COUNCIL <your model> VERDICT: CHANGES <SHA>
  followed by the blocking findings, then "Backlog" items if any. Then reply with the same verdict line.
```

## Rules

- **Token thrift (owner direction, 2026-10-29).** Usage limits are the constraint, not wall time. Fix small findings yourself instead of starting a fixer; give a fixer all findings of a round at once; re-reviews cover the fixes only; keep `status.md` short (one line per merged task, details live in the PR); read only the parts of files you need.

- **Focus (owner direction, 2026-10-28).** Ship a working MVP for linux-x64 (D24). Follow the critical path; do not spend agents on macOS, arm64, optional cleanups or carried notes unless they block the current task. CI is one Linux x64 job; a check is green when that job passes.

- **No owner input.** Every question is decided by the lead. Design decisions go into `docs/design/10-decisions.md` marked "Decided by agents on <date>, for owner review" and are listed in `status.md`.
- **Pace.** One task at a time. At most two agents at once (worker or fixer, and reviewer). If an agent fails with a usage or rate limit, write "Paused until <now + 60 min>" in `status.md`, commit, push, release the lock and end the run. Do not retry in a loop.
- **Failures.** A worker that ends without a usable PR gets one retry with a sharper brief. After that, mark the task blocked in `status.md` with the reason and move to the next task whose dependencies are met.
- **Hard limits** from the work plan always apply: no production data, no real credentials, no external services beyond GitHub and the upstream forge, nothing destructive outside the repository, and the host rules in `/home/t3-code/AGENTS.md`.
- **Plan changes.** The lead may change the work plan, this runbook and design docs when a spike or upstream behavior requires it. Commit those changes to `main` with a clear message and note them in `status.md`.
