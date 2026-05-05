import { readFileSync } from "node:fs";
import { isAuthorized as cedarIsAuthorized } from "@cedar-policy/cedar-wasm/nodejs";
import type {
  AuthorizationCall,
  Entities,
} from "@cedar-policy/cedar-wasm/nodejs";

export interface AuthzResult {
  decision: "ALLOW" | "DENY";
  determiningPolicies: string[];
  errors: string[];
}

interface PolicyEntry {
  id: string;
  text: string;
}

let policySet: Record<string, string> | null = null;
let policyEntries: PolicyEntry[] = [];
let entities: Entities | null = null;
let policiesPath = "";
let entitiesPath = "";

const parsePolicies = (text: string): PolicyEntry[] => {
  const stripped = text.replace(/\/\/[^\n]*\n/g, "\n");
  const out: PolicyEntry[] = [];
  const re = /@id\("([^"]+)"\)\s*([\s\S]*?;)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const id = m[1];
    const body = m[2];
    if (!id || !body) continue;
    out.push({ id, text: `@id("${id}")\n${body.trim()}` });
  }
  if (out.length === 0) {
    throw new Error(
      "no @id-annotated policies found — every policy must start with @id(\"name\")"
    );
  }
  const seen = new Set<string>();
  for (const p of out) {
    if (seen.has(p.id)) {
      throw new Error(`duplicate @id annotation: ${p.id}`);
    }
    seen.add(p.id);
  }
  return out;
};

export const loadCedar = (policiesFile: string, entitiesFile: string): void => {
  policiesPath = policiesFile;
  entitiesPath = entitiesFile;
  const policiesText = readFileSync(policiesFile, "utf8");
  policyEntries = parsePolicies(policiesText);
  policySet = Object.fromEntries(policyEntries.map((p) => [p.id, p.text]));
  entities = JSON.parse(readFileSync(entitiesFile, "utf8")) as Entities;
};

export const reloadCedar = (): void => {
  if (!policiesPath) throw new Error("loadCedar must be called first");
  loadCedar(policiesPath, entitiesPath);
};

export const getPolicyText = (): string => {
  if (!policiesPath) throw new Error("loadCedar must be called first");
  return readFileSync(policiesPath, "utf8");
};

export const getEntitiesText = (): string => {
  if (!entitiesPath) throw new Error("loadCedar must be called first");
  return readFileSync(entitiesPath, "utf8");
};

export interface EntityRef {
  type: string;
  id: string;
}

export interface ResourceRef extends EntityRef {
  attrs?: Record<string, unknown>;
}

export const isAuthorized = (params: {
  principal: EntityRef;
  action: string;
  resource: ResourceRef;
  context?: Record<string, unknown>;
}): AuthzResult => {
  if (!policySet || !entities) {
    throw new Error("Cedar not initialized — call loadCedar() first");
  }

  const uidKey = (uid: EntityRef): string => `${uid.type}::"${uid.id}"`;
  const existing = new Set(entities.map((e) => uidKey(e.uid)));
  const synthesized: Entities = [];
  if (!existing.has(uidKey(params.principal))) {
    synthesized.push({
      uid: { type: params.principal.type, id: params.principal.id },
      attrs: {},
      parents: [],
    });
  }
  const resourceUid = { type: params.resource.type, id: params.resource.id };
  if (!existing.has(uidKey(resourceUid))) {
    synthesized.push({
      uid: resourceUid,
      attrs: params.resource.attrs ?? {},
      parents: [],
    });
  }

  const call: AuthorizationCall = {
    principal: params.principal,
    action: { type: "Action", id: params.action },
    resource: resourceUid,
    context: params.context ?? {},
    policies: { staticPolicies: policySet },
    entities: [...entities, ...synthesized],
  };
  const ans = cedarIsAuthorized(call);
  if (ans.type === "failure") {
    return {
      decision: "DENY",
      determiningPolicies: [],
      errors: ans.errors.map((e) => e.message ?? String(e)),
    };
  }
  return {
    decision: ans.response.decision === "allow" ? "ALLOW" : "DENY",
    determiningPolicies: ans.response.diagnostics.reason,
    errors: ans.response.diagnostics.errors.map(
      (e) => `${e.policyId}: ${e.error.message ?? "error"}`
    ),
  };
};
