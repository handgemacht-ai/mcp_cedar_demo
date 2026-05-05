import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const hookPath = resolve(repoRoot, ".claude/hooks/cedar-gate.ts");

interface Fixture {
  branch: string;
  repo: string;
  default_branch: string;
  has_open_pr: boolean;
  current_pr_number: number;
}

interface Scenario {
  name: string;
  fixture: Fixture;
  toolName: "mcp__gh-pr__create_pr" | "mcp__gh-pr__edit_pr";
  toolInput: Record<string, unknown>;
  agentType: string | null;
  expected: "allow" | "deny";
}

const scenarios: Scenario[] = [
  {
    name: "main, branch w/o PR, create_pr",
    fixture: { branch: "feat/a", repo: "demo/app", default_branch: "main", has_open_pr: false, current_pr_number: 0 },
    toolName: "mcp__gh-pr__create_pr",
    toolInput: { title: "x", body: "" },
    agentType: null,
    expected: "allow",
  },
  {
    name: "main, branch w/o PR, edit_pr",
    fixture: { branch: "feat/a", repo: "demo/app", default_branch: "main", has_open_pr: false, current_pr_number: 0 },
    toolName: "mcp__gh-pr__edit_pr",
    toolInput: { pr: "current", title: "x" },
    agentType: null,
    expected: "deny",
  },
  {
    name: "main, branch w/ PR #42, create_pr",
    fixture: { branch: "feat/a", repo: "demo/app", default_branch: "main", has_open_pr: true, current_pr_number: 42 },
    toolName: "mcp__gh-pr__create_pr",
    toolInput: { title: "x" },
    agentType: null,
    expected: "deny",
  },
  {
    name: "main, branch w/ PR #42, edit_pr (current)",
    fixture: { branch: "feat/a", repo: "demo/app", default_branch: "main", has_open_pr: true, current_pr_number: 42 },
    toolName: "mcp__gh-pr__edit_pr",
    toolInput: { pr: "current", title: "y" },
    agentType: null,
    expected: "allow",
  },
  {
    name: "main, branch w/ PR #42, edit_pr #99",
    fixture: { branch: "feat/a", repo: "demo/app", default_branch: "main", has_open_pr: true, current_pr_number: 42 },
    toolName: "mcp__gh-pr__edit_pr",
    toolInput: { pr: 99, title: "y" },
    agentType: null,
    expected: "deny",
  },
  {
    name: "main, branch w/ PR #42, edit_pr #42 (matching)",
    fixture: { branch: "feat/a", repo: "demo/app", default_branch: "main", has_open_pr: true, current_pr_number: 42 },
    toolName: "mcp__gh-pr__edit_pr",
    toolInput: { pr: 42, title: "y" },
    agentType: null,
    expected: "allow",
  },
  {
    name: "main, on default branch, create_pr",
    fixture: { branch: "main", repo: "demo/app", default_branch: "main", has_open_pr: false, current_pr_number: 0 },
    toolName: "mcp__gh-pr__create_pr",
    toolInput: { title: "x" },
    agentType: null,
    expected: "deny",
  },
  {
    name: "subagent, branch w/o PR, create_pr",
    fixture: { branch: "feat/a", repo: "demo/app", default_branch: "main", has_open_pr: false, current_pr_number: 0 },
    toolName: "mcp__gh-pr__create_pr",
    toolInput: { title: "x" },
    agentType: "general-purpose",
    expected: "deny",
  },
  {
    name: "subagent, branch w/ PR, edit_pr",
    fixture: { branch: "feat/a", repo: "demo/app", default_branch: "main", has_open_pr: true, current_pr_number: 42 },
    toolName: "mcp__gh-pr__edit_pr",
    toolInput: { pr: "current", title: "y" },
    agentType: "general-purpose",
    expected: "deny",
  },
  {
    name: "main, lookup failed (branch=''), create_pr",
    fixture: { branch: "", repo: "", default_branch: "", has_open_pr: false, current_pr_number: 0 },
    toolName: "mcp__gh-pr__create_pr",
    toolInput: { title: "x" },
    agentType: null,
    expected: "deny",
  },
];

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: string;
    permissionDecision: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
  };
}

const runOne = async (s: Scenario): Promise<{ ok: boolean; got: string; reason: string }> => {
  const stdinPayload: Record<string, unknown> = {
    session_id: "smoke",
    transcript_path: "/dev/null",
    cwd: repoRoot,
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: s.toolName,
    tool_input: s.toolInput,
    tool_use_id: "smoke",
  };
  if (s.agentType !== null) {
    stdinPayload["agent_id"] = "smoke-sub";
    stdinPayload["agent_type"] = s.agentType;
  }

  const proc = Bun.spawn([hookPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: repoRoot,
      CEDAR_GATE_BRANCH_PR_FIXTURE: JSON.stringify(s.fixture),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(stdinPayload));
  await proc.stdin.end();
  const exitCode = await proc.exited;
  const stdout = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();

  if (exitCode !== 0) {
    return { ok: false, got: `exit=${exitCode}`, reason: stderr || "no stderr" };
  }
  let parsed: HookOutput;
  try {
    parsed = JSON.parse(stdout) as HookOutput;
  } catch {
    return { ok: false, got: "unparseable", reason: stdout };
  }
  const got = parsed.hookSpecificOutput.permissionDecision;
  return {
    ok: got === s.expected,
    got,
    reason: parsed.hookSpecificOutput.permissionDecisionReason ?? "",
  };
};

const main = async () => {
  let pass = 0;
  let fail = 0;
  for (const s of scenarios) {
    const r = await runOne(s);
    const status = r.ok ? "PASS" : "FAIL";
    const mark = r.ok ? " " : "!";
    console.log(`${mark}${status} | expect=${s.expected.padEnd(5)} got=${r.got.padEnd(5)} | ${s.name}`);
    if (!r.ok) {
      console.log(`        reason: ${r.reason}`);
      fail++;
    } else {
      pass++;
    }
  }
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail === 0 ? 0 : 1);
};

main();
