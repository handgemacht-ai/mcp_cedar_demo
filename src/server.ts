import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { runGh } from "./gh.ts";

const INSTRUCTIONS = `Thin wrapper around \`gh pr create\`, \`gh pr edit\`, and \`gh pr close\`. Authorization is not enforced by this server. In this demo, a Claude Code PreToolUse hook (\`.claude/hooks/cedar-gate.ts\`) evaluates \`policies/policies.cedar\` for every \`mcp__gh-pr__*\` call before it reaches the tool; the same policies could be evaluated inside the server instead. See the repo README for the placement comparison.`;

const mcpServer = new McpServer(
  { name: "gh-pr", version: "1.0.0" },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
);

const textResult = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  ...(isError ? { isError: true } : {}),
});

const renderGh = (args: string[], result: { stdout: string; stderr: string; exitCode: number }) => {
  if (result.exitCode === 0) {
    return textResult(result.stdout.trim() || `gh ${args.join(" ")} ok`);
  }
  return textResult(
    `gh ${args.join(" ")} exited ${result.exitCode}\n${result.stderr.trim()}`,
    true
  );
};

mcpServer.registerTool(
  "create_pr",
  {
    description:
      "Create a pull request from the current branch via `gh pr create`. The PreToolUse hook will deny if the branch already has an open PR or is the default branch.",
    inputSchema: {
      title: z.string().min(1).describe("PR title"),
      body: z.string().default("").describe("PR body / description"),
      base: z
        .string()
        .optional()
        .describe("Base branch (defaults to repo's default branch)"),
      draft: z.boolean().default(false).describe("Open as draft PR"),
    },
  },
  async ({ title, body, base, draft }) => {
    const args = ["pr", "create", "--title", title, "--body", body];
    if (base) args.push("--base", base);
    if (draft) args.push("--draft");
    return renderGh(args, await runGh(args));
  }
);

mcpServer.registerTool(
  "edit_pr",
  {
    description:
      "Edit a pull request via `gh pr edit`. By default targets the PR for the current branch (`pr: \"current\"`). The PreToolUse hook will deny if the targeted PR isn't the current branch's open PR.",
    inputSchema: {
      pr: z
        .union([z.number().int().positive(), z.literal("current")])
        .default("current")
        .describe("PR number, or \"current\" for the current branch's PR"),
      title: z.string().optional().describe("New title"),
      body: z.string().optional().describe("New body"),
      add_label: z.string().optional().describe("Label to add"),
    },
  },
  async ({ pr, title, body, add_label }) => {
    const target = pr === "current" ? [] : [String(pr)];
    const args = ["pr", "edit", ...target];
    if (title !== undefined) args.push("--title", title);
    if (body !== undefined) args.push("--body", body);
    if (add_label !== undefined) args.push("--add-label", add_label);
    if (args.length === (2 + target.length)) {
      return textResult("edit_pr called with no fields to update", true);
    }
    return renderGh(args, await runGh(args));
  }
);

mcpServer.registerTool(
  "close_pr",
  {
    description:
      "Close a pull request via `gh pr close`. By default targets the PR for the current branch. Optionally deletes the head branch after close. The PreToolUse hook will deny if the targeted PR isn't the current branch's open PR.",
    inputSchema: {
      pr: z
        .union([z.number().int().positive(), z.literal("current")])
        .default("current")
        .describe("PR number, or \"current\" for the current branch's PR"),
      comment: z.string().optional().describe("Closing comment"),
      delete_branch: z
        .boolean()
        .default(false)
        .describe("Also delete the head branch after closing"),
    },
  },
  async ({ pr, comment, delete_branch }) => {
    const target = pr === "current" ? [] : [String(pr)];
    const args = ["pr", "close", ...target];
    if (comment !== undefined) args.push("--comment", comment);
    if (delete_branch) args.push("--delete-branch");
    return renderGh(args, await runGh(args));
  }
);

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
console.error("gh-pr MCP server ready");
