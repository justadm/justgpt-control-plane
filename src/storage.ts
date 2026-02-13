import fs from "node:fs";
import path from "node:path";

export type ProjectType = "json" | "openapi" | "postgres" | "mysql";

export type Project = {
  id: string;
  type: ProjectType;
  createdAt: string;
  mcpPath: string;
  tokenEnv: string;
  status: "draft" | "deployed";
  lastDeployAt: string | null;
  hostPort: number | null;
  nginxChanged: boolean | null;
  // Для MVP храним JSON inline (может быть большим); позже вынесем в отдельное хранилище.
  jsonInline: string | null;
  jsonUrl: string | null;
};

export type Db = {
  projects: Project[];
};

function nowIso() {
  return new Date().toISOString();
}

export function defaultDb(): Db {
  return { projects: [] };
}

export function resolveDataPath(p: string) {
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

export function loadDb(filePath: string): Db {
  const abs = resolveDataPath(filePath);
  if (!fs.existsSync(abs)) return defaultDb();
  const raw = fs.readFileSync(abs, "utf8").trim();
  if (!raw) return defaultDb();
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") return defaultDb();
  const projects = Array.isArray((parsed as any).projects) ? (parsed as any).projects : [];
  return { projects };
}

export function saveDb(filePath: string, db: Db) {
  const abs = resolveDataPath(filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + "\n");
  fs.renameSync(tmp, abs);
}

export function upsertProject(
  filePath: string,
  p: Omit<Project, "createdAt" | "status" | "lastDeployAt" | "hostPort" | "nginxChanged">,
) {
  const db = loadDb(filePath);
  const existing = db.projects.find((x) => x.id === p.id);
  if (existing) {
    existing.type = p.type;
    existing.mcpPath = p.mcpPath;
    existing.tokenEnv = p.tokenEnv;
    existing.jsonInline = (p as any).jsonInline ?? existing.jsonInline ?? null;
    existing.jsonUrl = (p as any).jsonUrl ?? existing.jsonUrl ?? null;
    saveDb(filePath, db);
    return existing;
  }

  const created: Project = {
    ...p,
    createdAt: nowIso(),
    status: "draft",
    lastDeployAt: null,
    hostPort: null,
    nginxChanged: null,
    jsonInline: (p as any).jsonInline ?? null,
    jsonUrl: (p as any).jsonUrl ?? null,
  };
  db.projects.push(created);
  saveDb(filePath, db);
  return created;
}

export function markDeployed(
  filePath: string,
  id: string,
  info?: { hostPort?: number | null; nginxChanged?: boolean | null },
) {
  const db = loadDb(filePath);
  const p = db.projects.find((x) => x.id === id);
  if (!p) return null;
  p.status = "deployed";
  p.lastDeployAt = nowIso();
  if (typeof info?.hostPort === "number") p.hostPort = info.hostPort;
  if (typeof info?.nginxChanged === "boolean") p.nginxChanged = info.nginxChanged;
  saveDb(filePath, db);
  return p;
}
