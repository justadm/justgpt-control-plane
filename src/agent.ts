import fs from "node:fs";
import { execSync } from "node:child_process";
import Fastify from "fastify";
import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(19101),
  HOST: z.string().min(1).default("0.0.0.0"),
  TOKEN: z.string().min(1),
  MCP_REPO_DIR: z.string().min(1).default("/opt/justgpt-mcp-service"),
  NGINX_SITE: z.string().min(1).default("/etc/nginx/sites-available/justgpt.ru.https"),
  MCP_ENV_FILE: z.string().min(1).default("/opt/justgpt-mcp-service/deploy/.env"),
});

const env = Env.parse(process.env);

const app = Fastify({ logger: true });

function sh(cmd: string) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function requireAuth(req: any) {
  const token = String(req.headers["x-agent-token"] || "");
  if (!token || token !== env.TOKEN) {
    const err: any = new Error("unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

function ensureEnvLine(file: string, key: string, value: string) {
  const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = raw.split(/\r?\n/);
  let found = false;
  const out = lines
    .map((l) => {
      if (l.startsWith(key + "=")) {
        found = true;
        return `${key}=${value}`;
      }
      return l;
    })
    .filter((l, idx, arr) => !(idx === arr.length - 1 && l === ""));

  if (!found) out.push(`${key}=${value}`);
  fs.writeFileSync(file, out.join("\n") + "\n");
}

function tokenEnvForProjectId(id: string) {
  return `MCP_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BEARER_TOKEN`;
}

function randToken() {
  // URL-safe, good enough for bearer in MVP.
  return sh("python3 -c 'import secrets; print(secrets.token_urlsafe(32))'").trim();
}

app.get("/health", async () => ({ ok: true }));

app.post("/deploy", async (req, reply) => {
  requireAuth(req);

  const Body = z.object({
    id: z.string().min(1),
    type: z.enum(["json", "openapi", "postgres", "mysql"]),
    mcpPath: z.string().min(1).optional(),
  });
  const body = Body.parse(req.body);

  const id = body.id.trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    reply.code(400);
    return { error: "bad id" };
  }

  const mcpPath = body.mcpPath?.trim() || `/p/${id}/mcp`;

  const tokenEnv = tokenEnvForProjectId(id);
  const token = randToken();

  // Pull latest mcp-service repo.
  sh(`cd ${env.MCP_REPO_DIR} && sudo -n git pull --ff-only`);

  // Generate project files via mcp-service init. We do not auto-patch nginx template in repo.
  // Nginx routing on VM is handled separately by manual template sync today.
  sh(
    `cd ${env.MCP_REPO_DIR} && sudo -n npm install --silent >/dev/null 2>&1 || true; sudo -n npm run build >/dev/null 2>&1; ` +
      `sudo -n node dist/cli.js init --id ${id} --type ${body.type} --path ${mcpPath} --no-update-env-example --no-update-nginx`,
  );

  // Ensure token in deploy/.env
  ensureEnvLine(env.MCP_ENV_FILE, tokenEnv, token);

  // Bring up compose for project.
  sh(`cd ${env.MCP_REPO_DIR} && sudo -n docker compose -f deploy/docker-compose.nginx.${id}.yml up -d --build`);

  return {
    ok: true,
    id,
    mcpPath,
    tokenEnv,
    token,
    note:
      "Nginx route still requires adding location block for the new path on VM (automate next).",
  };
});

app.setErrorHandler((err: any, _req, reply) => {
  const code = Number(err?.statusCode) || 500;
  reply.code(code);
  reply.send({ error: String(err?.message || err) });
});

app.listen({ port: env.PORT, host: env.HOST });
