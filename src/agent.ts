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
  const prelude =
    `apk add --no-cache git >/dev/null 2>&1 || true; ` +
    `git config --global --add safe.directory ${env.MCP_REPO_DIR} >/dev/null 2>&1 || true; `;
  return sh(
    `docker run --rm -v ${env.MCP_REPO_DIR}:${env.MCP_REPO_DIR} -w ${env.MCP_REPO_DIR} node:22-alpine sh -lc '${prelude}${q}'`,
  );
}

function readHostPortFromCompose(projectId: string) {
  const composeFile = `${env.MCP_REPO_DIR}/deploy/docker-compose.nginx.${projectId}.yml`;
  const raw = fs.readFileSync(composeFile, "utf8");
  const m = raw.match(/127\\.0\\.0\\.1:(19\\d{3}):8080/);
  if (!m) throw new Error(`cannot find host port mapping in ${composeFile}`);
  return Number(m[1]);
}

function ensureMcpNginxRoute(mcpPath: string, hostPort: number) {
  const raw = fs.readFileSync(env.NGINX_SITE, "utf8");
  const locLine = `    location = ${mcpPath} {`;
  if (raw.includes(locLine)) return false;

  const mcpNeedle = "\n    server_name mcp.justgpt.ru;\n";
  const mcpPos = raw.indexOf(mcpNeedle);
  if (mcpPos < 0) throw new Error("mcp server block not found in nginx site");

  const insertionNeedle = "\n    location / {\n        return 404;\n    }\n";
  const insPos = raw.indexOf(insertionNeedle, mcpPos);
  if (insPos < 0) throw new Error("cannot find insertion point in mcp server block");

  const block =
    `\n    location = ${mcpPath} {\n` +
    `        proxy_pass http://127.0.0.1:${hostPort};\n` +
    `        proxy_set_header Host $host;\n` +
    `        proxy_set_header X-Forwarded-Proto $scheme;\n` +
    `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n` +
    `        proxy_set_header Connection \"\";\n` +
    `    }\n`;

  const out = raw.slice(0, insPos) + block + raw.slice(insPos);
  fs.writeFileSync(env.NGINX_SITE, out);
  return true;
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
  host("git pull --ff-only");

  // Generate project files via mcp-service init. We do not auto-patch nginx template in repo.
  // Nginx routing on VM is handled separately by manual template sync today.
  // Generate project files via mcp-service init (host).
  // Node/npm/tsc must exist on the host in this MVP flow.
  host(
    `npm install --silent >/dev/null 2>&1 || true; ` +
      `npm run build >/dev/null 2>&1; ` +
      `node dist/cli.js init --id ${id} --type ${body.type} --path ${mcpPath} --no-update-env-example --no-update-nginx`,
  );

  // Ensure token in deploy/.env
  ensureEnvLine(env.MCP_ENV_FILE, tokenEnv, token);

  // Bring up compose for project.
  asRoot(`cd ${env.MCP_REPO_DIR} && docker compose -f deploy/docker-compose.nginx.${id}.yml up -d --build`);

  const hostPort = readHostPortFromCompose(id);
  const nginxChanged = ensureMcpNginxRoute(mcpPath, hostPort);
  if (nginxChanged) {
    // Validate + reload nginx on host (container must run with pid: host and /run mounted).
    asRoot("nginx -t");
    asRoot("nginx -s reload");
  }

  return {
    ok: true,
    id,
    mcpPath,
    hostPort,
    tokenEnv,
    token,
    nginxChanged,
  };
});

app.setErrorHandler((err: any, _req, reply) => {
  const code = Number(err?.statusCode) || 500;
  reply.code(code);
  reply.send({ error: String(err?.message || err) });
});

app.listen({ port: env.PORT, host: env.HOST });
