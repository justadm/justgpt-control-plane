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
});

const env = Env.parse(process.env);

const app = Fastify({ logger: true });

app.register(fastifyStatic, {
  root: path.join(process.cwd(), "public"),
  prefix: "/",
});

app.get("/health", async () => ({ ok: true }));

app.get("/api/projects", async () => {
  const db = loadDb(env.DATA_FILE);
  return { projects: db.projects };
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

  // MVP: автодеплой выключен. На этом шаге просто отмечаем deployed для UI.
  // Следующий шаг: реально дергать mcp-service init и docker/nginx на VM.
  const p = markDeployed(env.DATA_FILE, id);
  if (!p) {
    reply.code(404);
    return { error: "project not found" };
  }

  return { ok: true, project: p, note: "Автодеплой еще не реализован (MVP control-plane)" };
});

app.listen({ port: env.PORT, host: env.HOST });
