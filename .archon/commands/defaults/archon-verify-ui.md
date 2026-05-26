---
description: Boot an ISOLATED dev server in the worktree and use agent-browser to visually verify a web/UI fix before the PR is opened; self-fix on failure
argument-hint: (none - reads from $ARTIFACTS_DIR)
---

# In-Loop Browser Verification (web/UI fixes)

You changed the web UI. **Before the PR is opened**, you must *see* the change render correctly
in a real browser, and **self-fix** until it is good. A human reviewer should never be the first
to lay eyes on it.

You run **inside the Archon container that is orchestrating this very workflow** (dogfood). There
is **no sandbox** — only this worktree isolates the code. So two rules are absolute:

**ABSOLUTELY FORBIDDEN — these would kill the parent Archon, the orchestrator, or other workflows:**
- `pkill bun`, `pkill node`, `pkill -f bun`, `pkill chrome`, or any broad process-name kill.
- `taskkill //F //IM <name>` of any kind.
- `agent-browser close` **without** `--session "$WORKFLOW_ID"`.
- Touching, deleting, or pointing the child server at `/.archon/archon.db` (the **live** database).
- If you cannot bring the server up after 2 attempts, **STOP**, write an `UNVERIFIED` verdict
  (Phase 4) and exit 0 — do not escalate to broad kills.

Kill **only** by the PID files you recorded and the two ports you allocated.

---

## Phase 0: Load context

```bash
WORKTREE=$(pwd)
BACKEND_PORT=$(cat "$ARTIFACTS_DIR/.backend-port" | tr -d '\n')
FRONTEND_PORT=$(cat "$ARTIFACTS_DIR/.frontend-port" | tr -d '\n')
echo "Worktree: $WORKTREE  Backend: $BACKEND_PORT  Frontend: $FRONTEND_PORT"
```

Read what to verify and what changed:

```bash
cat "$ARTIFACTS_DIR/investigation.md" 2>/dev/null | head -200   # the bug + manual verification steps
cat "$ARTIFACTS_DIR/implementation.md" 2>/dev/null | head -200  # what was changed
```

Also inspect the diff so you know exactly which UI surface to look at:

```bash
git diff --name-only "$BASE_BRANCH"...HEAD | grep '^packages/web/'
```

Derive a concrete **verification goal**: the user-visible thing that must now be correct (e.g. "a
`script:` node renders a lime SCRIPT badge with `name (runtime)`, not an empty PROMPT node").

## Phase 1: Start an ISOLATED Archon (never touches the live DB)

The child server **must** use a throwaway home so it cannot read or write the live database. Always
set `ARCHON_HOME` to a dir under `$ARTIFACTS_DIR` and force `DATABASE_URL` empty (SQLite-only).

```bash
mkdir -p "$ARTIFACTS_DIR/.verify-home"

# Install deps in the worktree (slow, first run only)
cd "$WORKTREE" && bun install --frozen-lockfile 2>/dev/null || bun install

# Backend — FULLY ISOLATED state. CRITICAL: in the Docker image `ARCHON_DOCKER=true`
# forces getArchonHome() to `/.archon`, which makes `ARCHON_HOME` IGNORED and the
# SQLite DB resolve to the LIVE `/.archon/archon.db`. So we must ALSO clear
# ARCHON_DOCKER + WORKSPACE_PATH for the child, so isDocker()=false and ARCHON_HOME
# (the throwaway dir) actually takes effect. (No-op on non-Docker hosts.)
cd "$WORKTREE"
env -u ARCHON_DOCKER -u WORKSPACE_PATH \
  ARCHON_HOME="$ARTIFACTS_DIR/.verify-home" DATABASE_URL= PORT=$BACKEND_PORT \
  bun run --filter @archon/server dev > "$ARTIFACTS_DIR/.e2e-feature-backend.log" 2>&1 &
echo $! > "$ARTIFACTS_DIR/.e2e-feature-backend-pid"

# Poll health (max 60s)
WAITED=0
until curl -sf "http://localhost:$BACKEND_PORT/api/health" > /dev/null 2>&1; do
  [ $WAITED -ge 60 ] && { echo "BACKEND FAILED"; tail -20 "$ARTIFACTS_DIR/.e2e-feature-backend.log"; break; }
  sleep 2; WAITED=$((WAITED+2))
done
```

```bash
# Frontend — use bunx (npm/npx are NOT in the container image). PORT=$BACKEND_PORT tells the
# vite dev proxy where the backend is; --port sets the frontend port.
cd "$WORKTREE/packages/web"
PORT=$BACKEND_PORT bunx vite --port "$FRONTEND_PORT" --host \
  > "$ARTIFACTS_DIR/.e2e-feature-frontend.log" 2>&1 &
echo $! > "$ARTIFACTS_DIR/.e2e-feature-frontend-pid"

WAITED=0
until curl -sf "http://localhost:$FRONTEND_PORT" > /dev/null 2>&1; do
  [ $WAITED -ge 60 ] && { echo "FRONTEND FAILED"; tail -20 "$ARTIFACTS_DIR/.e2e-feature-frontend.log"; break; }
  sleep 2; WAITED=$((WAITED+2))
done
```

If either server never becomes healthy after 2 attempts, jump to Phase 4 and record `UNVERIFIED`.

**Hard isolation gate** — the child must be using the throwaway DB, never the live one.
After the backend is healthy, confirm the isolated DB exists:

```bash
ls -la "$ARTIFACTS_DIR/.verify-home/archon.db" && echo "ISOLATED DB OK"
```

If `$ARTIFACTS_DIR/.verify-home/archon.db` does **not** exist once the server is healthy, the
isolation FAILED (the child is using the live `/.archon/archon.db`). **STOP immediately** — do not
seed any data or take any further action against this server. Kill it (scoped, by PID) and jump to
Phase 4 with verdict **UNVERIFIED** ("DB isolation gate failed — refusing to write the live DB").

## Phase 2: Verify in the browser

Load the **`agent-browser`** skill for the full command reference (it is preloaded for this node).
Use `--session "$WORKFLOW_ID"` on **every** call so you only ever touch your own browser.

Drive the UI to reach your verification goal. Seed any data you need **through the isolated
instance only** (its API on `$BACKEND_PORT`) — e.g. register the worktree as a codebase, author a
workflow that contains the node type you changed. Typical loop:

```bash
agent-browser --session "$WORKFLOW_ID" open "http://localhost:$FRONTEND_PORT"
agent-browser --session "$WORKFLOW_ID" wait --load networkidle
agent-browser --session "$WORKFLOW_ID" snapshot -i
# ...navigate to the surface you changed...
agent-browser --session "$WORKFLOW_ID" screenshot "$ARTIFACTS_DIR/ui-verify-01.png"
```

**Read each screenshot you take** (use the Read tool) and judge it against the verification goal.
Record a verdict: **PASS** (renders correctly), **FAIL** (renders wrong), or **UNVERIFIED**
(couldn't boot / couldn't reach the surface).

## Phase 3: Self-fix on FAIL (bounded)

If the verdict is **FAIL**, fix it and re-verify — up to **3 attempts**:

1. Edit the source in the worktree (`packages/web/...`).
2. Vite hot-reloads automatically; re-run `snapshot`/`screenshot` and re-judge.
3. If now correct → PASS. If still wrong after 3 attempts → record FAIL with what you observed.

If you made fixes, **commit them** (the create-pr step commits source, but commit here so your
change is attributed and durable). Stage **only** the web files you edited, by name — never
`git add -A`/`.`/`-u`:

```bash
git add packages/web/<file1> packages/web/<file2>
git commit -m "fix(web): correct rendering found during in-loop browser verification"
```

## Phase 4: Publish screenshots so they render in the PR

Screenshots in `$ARTIFACTS_DIR` are invisible to a PR reviewer. Push them to a `verify-artifacts`
side branch on the repo (NOT the PR branch — keeps them out of the merge diff) so `create-pr` can
embed them as images. Best-effort: if any step fails, skip it — `create-pr` falls back to naming the
files.

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)
BR=verify-artifacts
DEF=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null)
# Create the side branch once (off the default branch); ignore if it already exists.
if [ -n "$REPO" ] && ! gh api "repos/$REPO/git/ref/heads/$BR" >/dev/null 2>&1; then
  SHA=$(gh api "repos/$REPO/git/ref/heads/$DEF" --jq .object.sha 2>/dev/null)
  [ -n "$SHA" ] && gh api -X POST "repos/$REPO/git/refs" -f ref="refs/heads/$BR" -f sha="$SHA" >/dev/null 2>&1 || true
fi
# Upload each screenshot via the Contents API; record the raw URL (renders in markdown).
: > "$ARTIFACTS_DIR/.screenshot-urls"
for png in "$ARTIFACTS_DIR"/ui-verify-*.png; do
  [ -f "$png" ] || continue
  name=$(basename "$png")
  if [ -n "$REPO" ] && gh api -X PUT "repos/$REPO/contents/verification/$WORKFLOW_ID/$name" \
       -f message="verify-ui screenshot $name ($WORKFLOW_ID)" -f branch="$BR" \
       -f content="$(base64 -w0 "$png")" >/dev/null 2>&1; then
    echo "https://github.com/$REPO/raw/$BR/verification/$WORKFLOW_ID/$name" >> "$ARTIFACTS_DIR/.screenshot-urls"
  fi
done
cat "$ARTIFACTS_DIR/.screenshot-urls"
```

You will embed these URLs in the verdict's **Screenshots** section next (`![surface](url)`). If no
URLs were printed (push failed / no repo access), fall back to listing the `ui-verify-*.png`
filenames so the reviewer at least knows they exist in the artifacts.

## Phase 5: Clean up (scoped) and write the verdict

Best-effort cleanup of **your own** processes (the workflow's `cleanup-ui-verify` node is the
guaranteed safety net). Scoped only — re-read the FORBIDDEN list above.

```bash
agent-browser --session "$WORKFLOW_ID" close 2>/dev/null || true
for pidfile in "$ARTIFACTS_DIR"/.e2e-feature-*-pid; do
  [ -f "$pidfile" ] && kill "$(cat "$pidfile" | tr -d '\n')" 2>/dev/null || true
done
for PORT in $BACKEND_PORT $FRONTEND_PORT; do
  fuser -k "$PORT/tcp" 2>/dev/null || true
  lsof -ti:"$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
done
```

Write `$ARTIFACTS_DIR/ui-verification.md` (this is what the PR's "Human Verification" section will
quote). **Always** write it, even on UNVERIFIED:

```markdown
# UI Verification

**Verdict**: PASS | FAIL | UNVERIFIED
**Goal**: <the user-visible thing that had to be correct>

## Screenshots
<!-- Embed each URL from $ARTIFACTS_DIR/.screenshot-urls as an image so it renders in the PR. -->
![<surface, e.g. dashboard>](<raw-url-1>)
![<surface, e.g. chat>](<raw-url-2>)
<!-- If .screenshot-urls is empty (push failed), instead list: ui-verify-*.png (in $ARTIFACTS_DIR) -->

## What I saw
<observations per screenshot>

## Fixes applied during verification
<none, or the commits you made>

## If UNVERIFIED
<why the server couldn't boot or the surface couldn't be reached>
```

**Exit 0 in all cases** (PASS, FAIL, or UNVERIFIED) — never error out. A failed visual check is a
result to record and self-fix, not a reason to crash the run or escalate to broad process kills.

## Success criteria
- Server booted with an **isolated** `ARCHON_HOME` (live `/.archon/archon.db` untouched).
- A verdict written to `$ARTIFACTS_DIR/ui-verification.md` with at least one screenshot.
- Screenshots pushed to the `verify-artifacts` side branch and embedded (by raw URL) in the
  verdict's Screenshots section so they render in the PR.
- Only scoped (`--session` / PID / port) cleanup was used.
