#!/usr/bin/env bun
import { resolve } from "node:path";
import {
  loadCedar,
  isAuthorized,
  type EntityRef,
} from "../../src/cedar.ts";
import {
  initAudit,
  appendAudit,
  formatEntityUid,
} from "../../src/audit.ts";

interface PreToolUseInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  hook_event_name?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
}

interface Scope {
  branch: string;
  repo: string;
  default_branch: string;
  has_open_pr: boolean;
  current_pr_number: number;
  errors: string[];
}

const t0 = performance.now();

const projectDir =
  process.env["CLAUDE_PROJECT_DIR"] ?? resolve(import.meta.dirname, "..", "..");
const policiesPath = resolve(projectDir, "policies/policies.cedar");
const entitiesPath = resolve(projectDir, "policies/entities.json");
const auditPath = resolve(projectDir, "audit/audit.log");

const emit = (
  decision: "allow" | "deny",
  reason: string,
  exitCode = 0
): never => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }) + "\n"
  );
  process.exit(exitCode);
};

const runCmd = async (
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const proc = Bun.spawn([cmd, ...args], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, opts.timeoutMs ?? 3000);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
};

const resolveScope = async (cwd: string): Promise<Scope> => {
  const fixtureRaw = process.env["CEDAR_GATE_BRANCH_PR_FIXTURE"];
  if (fixtureRaw) {
    const f = JSON.parse(fixtureRaw) as Partial<Scope>;
    return {
      branch: f.branch ?? "",
      repo: f.repo ?? "fixture/repo",
      default_branch: f.default_branch ?? "main",
      has_open_pr: f.has_open_pr ?? false,
      current_pr_number: f.current_pr_number ?? 0,
      errors: [],
    };
  }

  const errors: string[] = [];

  const gitBranch = await runCmd("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
  });
  if (gitBranch.exitCode !== 0 || !gitBranch.stdout) {
    errors.push("not_a_git_repo");
    return {
      branch: "",
      repo: "",
      default_branch: "",
      has_open_pr: false,
      current_pr_number: 0,
      errors,
    };
  }
  const branch = gitBranch.stdout;

  const repoView = await runCmd(
    "gh",
    ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
    { cwd }
  );
  let repo = "";
  let default_branch = "";
  if (repoView.exitCode === 0) {
    try {
      const j = JSON.parse(repoView.stdout) as {
        nameWithOwner?: string;
        defaultBranchRef?: { name?: string };
      };
      repo = j.nameWithOwner ?? "";
      default_branch = j.defaultBranchRef?.name ?? "";
    } catch {
      errors.push("repo_view_parse_failed");
    }
  } else {
    errors.push("repo_view_failed");
  }

  const prList = await runCmd(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number,baseRefName",
      "--limit",
      "5",
    ],
    { cwd }
  );
  let has_open_pr = false;
  let current_pr_number = 0;
  if (prList.exitCode === 0) {
    try {
      const arr = JSON.parse(prList.stdout) as { number: number }[];
      if (arr.length === 1) {
        has_open_pr = true;
        current_pr_number = arr[0]!.number;
      } else if (arr.length > 1) {
        has_open_pr = true;
        current_pr_number = Math.min(...arr.map((p) => p.number));
        errors.push("multiple_open_prs");
      }
    } catch {
      errors.push("pr_list_parse_failed");
    }
  } else {
    errors.push("pr_list_failed");
  }

  if (!repo || !default_branch) {
    return {
      branch: "",
      repo,
      default_branch,
      has_open_pr,
      current_pr_number,
      errors,
    };
  }

  return { branch, repo, default_branch, has_open_pr, current_pr_number, errors };
};

const toolNameToAction = (toolName: string): string | null => {
  const suffix = toolName.replace(/^mcp__gh-pr__/, "");
  if (suffix === "create_pr") return "CreatePR";
  if (suffix === "edit_pr") return "EditPR";
  if (suffix === "close_pr") return "ClosePR";
  return null;
};

const main = async (): Promise<never> => {
  const stdinText = await Bun.stdin.text();
  let input: PreToolUseInput;
  try {
    input = JSON.parse(stdinText) as PreToolUseInput;
  } catch (e) {
    emit("deny", `cedar-gate: failed to parse stdin: ${e}`);
  }

  const cwd = input.cwd ?? projectDir;
  const agentType = input.agent_type ?? "main";
  const principal: EntityRef =
    input.agent_type === undefined
      ? { type: "Session", id: "main" }
      : { type: "Subagent", id: input.agent_type };

  const action = toolNameToAction(input.tool_name);
  if (!action) {
    emit("allow", `cedar-gate: ${input.tool_name} is not gated by this hook`);
  }

  const toolPrRaw = (input.tool_input as { pr?: unknown }).pr;
  const tool_pr_number =
    typeof toolPrRaw === "number" && Number.isFinite(toolPrRaw)
      ? toolPrRaw
      : 0;

  const scope = await resolveScope(cwd);

  const is_default_branch =
    scope.branch !== "" &&
    scope.default_branch !== "" &&
    scope.branch === scope.default_branch;

  const ctx = {
    has_open_pr: scope.has_open_pr,
    current_pr_number: scope.current_pr_number,
    tool_pr_number,
    branch: scope.branch,
    default_branch: scope.default_branch,
    repo: scope.repo,
    is_default_branch,
  };

  const resourceForAction =
    action === "CreatePR"
      ? {
          type: "Branch",
          id: `${scope.repo || "?"}@${scope.branch || "?"}`,
        }
      : {
          // EditPR | ClosePR
          type: "PullRequest",
          id: `${scope.repo || "?"}#${tool_pr_number || scope.current_pr_number || 0}`,
        };

  loadCedar(policiesPath, entitiesPath);
  const result = isAuthorized({
    principal,
    action: action!,
    resource: resourceForAction,
    context: ctx,
  });

  initAudit(auditPath);
  const elapsed_ms = Math.round(performance.now() - t0);
  appendAudit({
    ts: new Date().toISOString(),
    principal: formatEntityUid(principal),
    action: `Action::"${action}"`,
    resource: formatEntityUid(resourceForAction),
    decision: result.decision,
    determining_policies: result.determiningPolicies,
    errors: [...scope.errors, ...result.errors],
    tool_name: input.tool_name,
    agent_type: agentType,
    cwd,
    branch: scope.branch,
    pr_number: scope.current_pr_number,
    elapsed_ms,
  });

  if (result.decision === "ALLOW") {
    const why = result.determiningPolicies.length
      ? `Cedar permit (${result.determiningPolicies.join(", ")})`
      : "Cedar permit";
    emit("allow", why);
  } else {
    const tail = result.determiningPolicies.length
      ? ` determining=${result.determiningPolicies.join(", ")}`
      : " (no permit matched)";
    const reason =
      `Cedar deny: ${input.tool_name} for ${formatEntityUid(principal)} on ` +
      `${formatEntityUid(resourceForAction)}${tail}` +
      (scope.errors.length ? ` [scope_errors=${scope.errors.join(",")}]` : "");
    emit("deny", reason);
  }
};

main().catch((err) => {
  emit("deny", `cedar-gate: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
});
