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
  // We rely on docker CLI for host operations.
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
  // Avoid python dependency inside container.
  return sh("node -e 'console.log(require(\"crypto\").randomBytes(32).toString(\"base64url\"))'").trim();
}

function asRoot(cmd: string) {
  // This container is expected to run as root on the VM (it mounts docker.sock and /etc/nginx).
  // Avoid depending on sudo inside the container.
  return sh(cmd);
}

function host(cmd: string) {
  // Execute on host via an ephemeral node container.
  // We need git + node + npm to run mcp-service init/build; node image includes them.
  const q = cmd.replaceAll("'", "'\"'\"'");
  return sh(
    `docker run --rm -v ${env.MCP_REPO_DIR}:${env.MCP_REPO_DIR} -w ${env.MCP_REPO_DIR} node:22-alpine sh -lc '${q}'`,
  );
}

function hostGitSafe() {
  // Git may refuse to work if repo ownership differs (common on servers).
  // Make it explicit for the ephemeral container.
  host(`git config --global --add safe.directory ${env.MCP_REPO_DIR} >/dev/null 2>&1 || true`);
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

  // Pull latest mcp-service repo (host).
  host("apk add --no-cache git >/dev/null 2>&1");
  hostGitSafe();
  host("git pull --ff-only");

  // Generate project files via mcp-service init. We do not auto-patch nginx template in repo.
  // Nginx routing on VM is handled separately by manual template sync today.
  // Generate project files via mcp-service init (host).
  // Node/npm/tsc must exist on the host in this MVP flow.
  host(
    `apk add --no-cache git >/dev/null 2>&1; ` +
      `git config --global --add safe.directory ${env.MCP_REPO_DIR} >/dev/null 2>&1 || true; ` +
      `npm install --silent >/dev/null 2>&1 || true; ` +
      `npm run build >/dev/null 2>&1; ` +
      `node dist/cli.js init --id ${id} --type ${body.type} --path ${mcpPath} --no-update-env-example --no-update-nginx`,
  );

  // Ensure token in deploy/.env
  ensureEnvLine(env.MCP_ENV_FILE, tokenEnv, token);

  // Bring up compose for project.
  asRoot(`cd ${env.MCP_REPO_DIR} && docker compose -f deploy/docker-compose.nginx.${id}.yml up -d --build`);

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
