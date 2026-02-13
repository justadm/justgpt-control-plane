import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { loadDb, markDeployed, upsertProject } from "./storage.js";
import { ProjectType, tokenEnvForProjectId, validateProjectId } from "./validate.js";

const Env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  DATA_FILE: z.string().min(1).default("data/projects.json"),
  MCP_BASE_URL: z.string().min(1).default("https://mcp.justgpt.ru"),
  AGENT_URL: z.string().min(1).default("http://host.docker.internal:19101"),
  AGENT_TOKEN: z.string().min(1).optional(),
});

const env = Env.parse(process.env);

const app = Fastify({ logger: true });

// Fastify по умолчанию кидает FST_ERR_CTP_EMPTY_JSON_BODY если content-type=application/json и body пустое.
// Для MVP удобнее принимать пустое тело как {} (это безопасно для наших эндпоинтов).
try {
  // default parser мешает переопределению; снимаем и ставим свой.
  (app as any).removeContentTypeParser?.("application/json");
} catch {
  // ignore
}
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
  const s = String(body ?? "").trim();
  if (!s) return done(null, {});
  try {
    return done(null, JSON.parse(s));
  } catch (e: any) {
    e.statusCode = 400;
    return done(e, undefined as any);
  }
});

app.register(fastifyStatic, {
  root: path.join(process.cwd(), "public"),
  prefix: "/",
});

app.get("/health", async () => ({ ok: true }));

app.get("/api/projects", async () => {
  const db = loadDb(env.DATA_FILE);
  return {
    projects: db.projects.map((p) => ({
      ...p,
      endpoint: `${env.MCP_BASE_URL}${p.mcpPath}`,
    })),
  };
});

app.post("/api/projects", async (req, reply) => {
  const Body = z.object({
    id: z.string().min(1),
    type: ProjectType,
    mcpPath: z.string().min(1).optional(),
  });
  const body = Body.parse(req.body);

  const id = validateProjectId(body.id);
  const tokenEnv = tokenEnvForProjectId(id);
  const mcpPath = body.mcpPath?.trim() || `/p/${id}/mcp`;

  const p = upsertProject(env.DATA_FILE, {
    id,
    type: body.type,
    mcpPath,
    tokenEnv,
  });

  reply.code(201);
  return {
    project: p,
    next: {
      endpoint: `${env.MCP_BASE_URL}${mcpPath}`,
      tokenEnv,
      note:
        "Деплой пока вручную: используй mcp-service init + docker compose + nginx reload. Автодеплой добавим следующим шагом.",
    },
  };
});

app.post("/api/projects/:id/deploy", async (req, reply) => {
  const id = validateProjectId(String((req.params as any).id || ""));

  const db = loadDb(env.DATA_FILE);
  const p0 = db.projects.find((x) => x.id === id);
  if (!p0) {
    reply.code(404);
    return { error: "project not found" };
  }

  if (!env.AGENT_TOKEN) {
    reply.code(503);
    return { error: "agent is not configured (AGENT_TOKEN is missing)" };
  }

  const r = await fetch(`${env.AGENT_URL}/deploy`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-token": env.AGENT_TOKEN,
    },
    body: JSON.stringify({
      id: p0.id,
      type: p0.type,
      mcpPath: p0.mcpPath,
    }),
  });

  const text = await r.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    reply.code(502);
    return { error: "deploy failed", agent: data };
  }

  // Сохраняем только несекретные части результата деплоя.
  const p = markDeployed(env.DATA_FILE, id, {
    hostPort: typeof data?.hostPort === "number" ? data.hostPort : null,
    nginxChanged: typeof data?.nginxChanged === "boolean" ? data.nginxChanged : null,
  });
  if (!p) {
    reply.code(404);
    return { error: "project not found" };
  }
  return { ok: true, project: p, agent: data };
});

app.listen({ port: env.PORT, host: env.HOST });
