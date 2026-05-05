# mcp_cedar_test

A self-contained demo of [Cedar](https://www.cedarpolicy.com) policy
enforcement applied to an [MCP](https://modelcontextprotocol.io) server's
tool calls — with the gate living in a Claude Code **PreToolUse hook**, not
in the server itself.

> Repo: <https://github.com/handgemacht-ai/mcp_cedar_demo>

The MCP server is a deliberately passive `gh pr` wrapper (two tools:
`create_pr`, `edit_pr`). Every call is intercepted by
`.claude/hooks/cedar-gate.ts`, which derives the worktree's branch and any
open PR association, evaluates `policies/policies.cedar`, and returns
`allow` / `deny` to the harness. The server only runs `gh` — it has no idea
Cedar exists.

## What this is

```
Claude Code (main session or Task subagent)
        |
        | tool call: mcp__gh-pr__create_pr {title, body, ...}
        v
+-------------------------------+
| PreToolUse hook               |   .claude/settings.json
| .claude/hooks/cedar-gate.ts   |   matcher: "mcp__gh-pr__.*"
|   1. parse stdin              |
|   2. git rev-parse HEAD       |
|   3. gh repo view             |
|   4. gh pr list --head <br>   |
|   5. cedar isAuthorized       |
|   6. append audit/audit.log   |
|   7. emit allow/deny JSON     |
+--------------+----------------+
   allow       |       deny
               v
        +--------------+
        | MCP server   |  src/server.ts
        | "gh-pr"      |  passive: shells out to `gh pr create|edit`
        +--------------+
```

- **Hook**: TypeScript + Bun, single self-contained file.
- **Cedar**: `@cedar-policy/cedar-wasm` (official WASM binding); policies in
  `policies/policies.cedar`.
- **MCP server**: 80 lines, two `registerTool` calls, no Cedar import.
- **Audit**: every gated call appends one JSONL line to `audit/audit.log`
  with the determining policy IDs.

## Why a hook (and not Cedar inside the server)

Putting Cedar in the hook keeps the MCP server *agnostic* — any MCP server
can be governed this way without modifying its code. The hook also gets
privileged access to the agent's runtime context (`agent_type`, `cwd`) that
a remote MCP couldn't see, which is exactly what the policy needs to enforce
"can this caller create a PR for *the worktree they're actually in*."

The trade-off: hooks are Claude-Code-specific. A truly cross-client
deployment would put Cedar behind the MCP and gate on identity + verified
state instead. This demo covers the local-trust-root case.

## Quickstart

```bash
bun install
gh auth status      # must be authenticated
claude              # from this directory; .mcp.json auto-launches gh-pr
```

That's it. The hook is loaded from the committed `.claude/settings.json` at
session start.

## Tool surface

| Tool | Maps to | Cedar action |
|---|---|---|
| `create_pr({title, body, base?, draft?})` | `gh pr create ...` | `Action::"CreatePR"` |
| `edit_pr({pr?, title?, body?, add_label?})` | `gh pr edit ...` | `Action::"EditPR"` |

`pr` defaults to `"current"` (gh resolves to the PR for the current branch).
Both tools are passive shells around `gh`; the policy work happens in the
hook before they ever run.

## Policy matrix

| Scenario | Principal | Action | `has_open_pr` | `tool_pr_number` | Default branch? | Decision | Determining policy |
|---|---|---|:-:|:-:|:-:|:-:|---|
| main, branch w/o PR, `create_pr` | `Session::"main"` | CreatePR | false | 0 | no | ALLOW | `create_pr_when_no_upstream` |
| main, branch w/o PR, `edit_pr` | `Session::"main"` | EditPR | false | 0 | no | DENY | (no permit) |
| main, branch w/ PR #42, `create_pr` | `Session::"main"` | CreatePR | true | 0 | no | DENY | (no permit) |
| main, branch w/ PR #42, `edit_pr` (current) | `Session::"main"` | EditPR | true | 0 | no | ALLOW | `edit_current_pr` |
| main, branch w/ PR #42, `edit_pr` for #99 | `Session::"main"` | EditPR | true | 99 | no | DENY | `forbid_cross_pr_targeting` |
| main, on default branch, `create_pr` | `Session::"main"` | CreatePR | false | 0 | yes | DENY | `forbid_create_from_default_branch` |
| subagent, anything | `Subagent::"<type>"` | any | any | any | any | DENY | (no permit applies) |
| Lookup failed (no git / no gh) | any | mutate | — | — | — | DENY | `forbid_mutate_without_branch` |

The `Session::"main"` vs `Subagent::"<type>"` split comes from the
`agent_type` field in the PreToolUse hook stdin — present only when a Task
subagent is the caller. Subagents get no `permit` rule, so they're denied
by default.

## How gating works

Inside `.claude/hooks/cedar-gate.ts` (one process per tool call, fresh each
time — policies reload live):

1. **Read stdin** as JSON: `tool_name`, `tool_input`, `cwd`, `agent_type?`.
2. **Resolve scope** from `cwd`:
   - `git rev-parse --abbrev-ref HEAD` → `branch`
   - `gh repo view --json nameWithOwner,defaultBranchRef` → `repo`, `default_branch`
   - `gh pr list --head <branch> --state open --json number,baseRefName` → `has_open_pr`, `current_pr_number`
   - Any failure → `branch = ""` (forces a `forbid_mutate_without_branch`).
3. **Build the Cedar request**:
   - `principal`: `Session::"main"` or `Subagent::"<agent_type>"`.
   - `action`: `CreatePR` or `EditPR` (mapped from the tool name suffix).
   - `resource`: `Branch::"<repo>@<branch>"` for create; `PullRequest::"<repo>#<n>"` for edit.
   - `context`: `{has_open_pr, current_pr_number, tool_pr_number, branch, default_branch, repo, is_default_branch}`.
4. **`isAuthorized`** → `{decision, determiningPolicies, errors}`.
5. **Audit**: one JSONL line to `audit/audit.log`.
6. **Emit** `{"hookSpecificOutput": {"permissionDecision": "allow"|"deny", "permissionDecisionReason": "..."}}` on stdout.

## Reading the audit log

```bash
tail -f audit/audit.log | jq -c '{ts, principal, action, resource, decision, determining_policies, branch, pr_number}'
```

Sample line:

```json
{
  "ts": "2026-05-05T11:30:01.234Z",
  "principal": "Session::\"main\"",
  "action": "Action::\"CreatePR\"",
  "resource": "Branch::\"demo/app@feat/x\"",
  "decision": "ALLOW",
  "determining_policies": ["create_pr_when_no_upstream"],
  "errors": [],
  "tool_name": "mcp__gh-pr__create_pr",
  "agent_type": "main",
  "cwd": "/srv/.../mcp_cedar_test",
  "branch": "feat/x",
  "pr_number": 0,
  "elapsed_ms": 412
}
```

## Editing the policies

Edit `policies/policies.cedar` and re-trigger any gated tool — the hook
re-reads the file on every invocation (fresh process per call), so policy
changes are live without restarting Claude. Each policy MUST be preceded
by `@id("name")` — the annotation value becomes the policy ID surfaced in
audit entries and `permissionDecisionReason` strings.

## Smoke test

```bash
bun scripts/smoke.ts
```

Drives the hook directly with synthetic stdin payloads and the
`CEDAR_GATE_BRANCH_PR_FIXTURE` env var injecting branch/PR state. No
network, no `gh`, no real git. Ten scenarios covering every policy path;
exits non-zero on any mismatch.

## What this is NOT

- **Not real PR governance.** A production "no duplicate PRs" rule belongs
  in GitHub's branch protection, not in a client-side hook. The demo's
  value is showing how Cedar wires into Claude Code's hook surface, not
  the policy itself.
- **Not multi-tenant.** Hooks are local to one Claude Code session. For a
  remote MCP serving many agents, Cedar would live behind the server and
  gate on identity + server-verified state — a different architecture.
- **Multiple PRs per branch are simplified.** If `gh pr list --head <branch>`
  returns more than one open PR, the hook picks the lowest number and
  records `multiple_open_prs` in the audit's `errors`. Real systems would
  surface this differently.
- **TOCTOU window.** The hook resolves PR association via `gh`; the MCP
  then runs the actual `gh pr create|edit`. State could change between the
  two — millisecond-scale window, fine for the demo, not safety-critical.
- **No Cedar schema.** Behavioral correctness is enforced by the smoke
  test, not by Cedar's `validate`. For production, add
  `policies/schema.cedarschema` and validate at hook startup.
