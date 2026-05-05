import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEntry {
  ts: string;
  principal: string;
  action: string;
  resource: string;
  decision: "ALLOW" | "DENY";
  determining_policies: string[];
  errors: string[];
  tool_name: string;
  agent_type: string;
  cwd: string;
  branch: string;
  pr_number: number;
  elapsed_ms: number;
}

let auditPath: string | null = null;

export const initAudit = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  auditPath = path;
};

export const appendAudit = (entry: AuditEntry): void => {
  if (!auditPath) {
    throw new Error("audit log not initialized — call initAudit() first");
  }
  appendFileSync(auditPath, JSON.stringify(entry) + "\n", "utf8");
};

export const formatEntityUid = (uid: { type: string; id: string }): string =>
  `${uid.type}::"${uid.id}"`;
