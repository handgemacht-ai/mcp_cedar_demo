# mcp_cedar_test

A worked example of using [Cedar](https://www.cedarpolicy.com) to authorize
[MCP](https://modelcontextprotocol.io) tool calls. Cedar is a policy
engine; `isAuthorized` is a function call against a policy set, so you
can invoke it in front of the MCP server (in the client) or behind it
(inside the server, before it dispatches the call). This repo runs the
front placement so you can read the wiring end-to-end; the
[Where Cedar can sit](#where-cedar-can-sit-relative-to-an-mcp-server)
section below covers when you'd choose each.

> Repo: <https://github.com/handgemacht-ai/mcp_cedar_demo>

The MCP server here is a small `gh pr` wrapper exposing three tools
(`create_pr`, `edit_pr`, `close_pr`). The Cedar check runs in a Claude Code
**PreToolUse hook** at `.claude/hooks/cedar-gate.ts`: it reads the tool
call, derives the worktree's branch and any open PR association, evaluates
`policies/policies.cedar`, and returns `allow` / `deny` to the harness.
The server holds no policy code in this layout — that's a property of
where the check is wired in this layout, not a stance on what servers
should do.

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
        | "gh-pr"      |  shells out to `gh pr create|edit|close`
        +--------------+
```

- **Hook**: TypeScript + Bun, single self-contained file.
- **Cedar**: `@cedar-policy/cedar-wasm` (official WASM binding); policies in
  `policies/policies.cedar`.
- **MCP server**: ~110 lines, three `registerTool` calls.
- **Audit**: every gated call appends one JSONL line to `audit/audit.log`
  with the determining policy IDs.

## Where Cedar can sit relative to an MCP server

A Cedar request is `(principal, action, resource, context)`; the engine
matches it against the policy set and returns `allow` / `deny`. That call
can run on either side of the MCP boundary. The policies don't change;
the principal, context, and trust assumptions do.

```
                    in front of MCP                  behind MCP
                    (this demo)
                    ┌────────────┐                   ┌────────────┐
  agent ──tool──▶   │   client   │ ──tool over───▶   │   server   │ ──side effect──▶
                    │ Cedar gate │     stdio/http    │ Cedar gate │
                    └────────────┘                   └────────────┘
                    principal:                       principal:
                    Session::"main"                  User::"alice@example"
```

| | In front of MCP (hook in client) | Behind MCP (check in server) |
|---|---|---|
| Process running Cedar | Client / agent harness | MCP server |
| Principal usually represents | The local agent / session (e.g. `Session::"main"`, `Subagent::"<type>"`) | An authenticated caller (OIDC subject, API key, service account) |
| Context Cedar can read | Agent runtime: `agent_type`, `cwd`, current worktree, transcript | Server-verified state: DB rows, upstream API responses, request headers |
| Trust model | Trusts the client to invoke the gate before the call leaves | Trusts nothing on the wire; server is the chokepoint |
| Reach | One client (here: Claude Code only) | Every caller of the MCP |
| TOCTOU | Window between hook decision and the server's `gh` call | Window between server decision and the upstream API call (e.g. GitHub). Both placements have a window — only the boundary differs. |
| Good fit when | You want to gate on agent runtime that only the client knows | The MCP serves multiple clients/agents and identity is verifiable |

Both placements are valid; production systems often use both, sharing one
policy file. This demo gates on `agent_type` and `cwd` — client-side
attributes — which is why the check sits in front of the MCP. A
behind-MCP demo would gate on different attributes (authenticated
subject, request headers, server-side state).

The same policy file would mostly work behind the MCP too: you'd swap
`Session::"main"` for the authenticated caller and supply the same
`context` keys from server-side state. Some keys don't translate cleanly,
though — `is_default_branch` is about *which* worktree the client is
sitting in, which a shared server can't observe; behind-MCP, that key
would either be dropped or re-modelled as a resource attribute.

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
| `close_pr({pr?, comment?, delete_branch?})` | `gh pr close ...` | `Action::"ClosePR"` |

`pr` defaults to `"current"` (gh resolves to the PR for the current branch).
All three tools are thin shells around `gh`; the Cedar check runs in the
hook before the tool body executes. (GitHub doesn't allow deleting PRs —
`close_pr` is the closest equivalent and can optionally delete the head
branch.)

## Policy matrix

| Scenario | Principal | Action | `has_open_pr` | `tool_pr_number` | Default branch? | Decision | Determining policy |
|---|---|---|:-:|:-:|:-:|:-:|---|
| main, branch w/o PR, `create_pr` | `Session::"main"` | CreatePR | false | 0 | no | ALLOW | `create_pr_when_no_upstream` |
| main, branch w/o PR, `edit_pr` | `Session::"main"` | EditPR | false | 0 | no | DENY | (no permit) |
| main, branch w/ PR #42, `create_pr` | `Session::"main"` | CreatePR | true | 0 | no | DENY | (no permit) |
| main, branch w/ PR #42, `edit_pr` (current) | `Session::"main"` | EditPR | true | 0 | no | ALLOW | `mutate_current_pr` |
| main, branch w/ PR #42, `close_pr` (current) | `Session::"main"` | ClosePR | true | 0 | no | ALLOW | `mutate_current_pr` |
| main, branch w/ PR #42, `edit_pr` or `close_pr` for #99 | `Session::"main"` | EditPR/ClosePR | true | 99 | no | DENY | `forbid_cross_pr_targeting` |
| main, on default branch, `create_pr` | `Session::"main"` | CreatePR | false | 0 | yes | DENY | `forbid_create_from_default_branch` |
| subagent, anything | `Subagent::"<type>"` | any | any | any | any | DENY | (no permit applies) |
| Lookup failed (no git / no gh) | `Session::"main"` | any | — | — | — | DENY | `forbid_actions_without_branch` |

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
   - Any failure → `branch = ""` (forces a `forbid_actions_without_branch`).
3. **Build the Cedar request**:
   - `principal`: `Session::"main"` or `Subagent::"<agent_type>"`.
   - `action`: `CreatePR`, `EditPR`, or `ClosePR` (mapped from the tool name suffix).
   - `resource`: `Branch::"<repo>@<branch>"` for create; `PullRequest::"<repo>#<n>"` for edit/close.
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
network, no `gh`, no real git. Covers every policy path across all three
tools; exits non-zero on any mismatch.

## What this is NOT

- **Not real PR governance.** A production "no duplicate PRs" rule belongs
  in GitHub's branch protection, not in a client-side hook. The demo's
  value is showing how Cedar wires into Claude Code's hook surface, not
  the policy itself.
- **Not multi-tenant.** Hooks run inside one Claude Code session, so the
  principal here is the local agent. For one decision point across many
  callers, move Cedar behind the MCP and gate on authenticated
  identity — see the placement table above.
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
