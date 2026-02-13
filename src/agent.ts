import fs from "node:fs";
import crypto from "node:crypto";
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

const JSON_MAX_BYTES = 2_000_000; // MVP лимит на размер JSON файла

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

function readEnvValue(file: string, key: string) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    if (!line.startsWith(key + "=")) continue;
    return line.slice((key + "=").length).trim();
  }
  return null;
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
  const m = raw.match(/127\.0\.0\.1:(19\d{3}):8080/);
  if (!m) throw new Error(`cannot find host port mapping in ${composeFile}`);
  return Number(m[1]);
}

function projectFiles(projectId: string) {
  return {
    project: `${env.MCP_REPO_DIR}/deploy/projects/${projectId}.yml`,
    compose: `${env.MCP_REPO_DIR}/deploy/docker-compose.nginx.${projectId}.yml`,
  };
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

async function fetchJsonText(url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const r = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "follow",
    });
    if (r.status === 304) return { status: 304, text: null as string | null, headers: r.headers };
    if (!r.ok) return { status: r.status, text: null as string | null, headers: r.headers };

    const ab = await r.arrayBuffer();
    if (ab.byteLength > JSON_MAX_BYTES) {
      throw new Error(`json too large: ${ab.byteLength} bytes (max ${JSON_MAX_BYTES})`);
    }
    const text = Buffer.from(ab).toString("utf8");
    return { status: 200, text, headers: r.headers };
  } finally {
    clearTimeout(timeout);
  }
}

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

app.get("/health", async () => ({ ok: true }));

app.post("/deploy", async (req, reply) => {
  requireAuth(req);

  const Body = z.object({
    id: z.string().min(1),
    type: z.enum(["json", "openapi", "postgres", "mysql"]),
    mcpPath: z.string().min(1).optional(),
    jsonInline: z.string().nullable().optional(),
    jsonUrl: z.string().nullable().optional(),
  });
  const body = Body.parse(req.body);

  const id = body.id.trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    reply.code(400);
    return { error: "bad id" };
  }

  const mcpPath = body.mcpPath?.trim() || `/p/${id}/mcp`;

  const tokenEnv = tokenEnvForProjectId(id);
  const files = projectFiles(id);

  // Pull latest mcp-service repo (host).
  host("git pull --ff-only");

  // For json projects, write managed data file under deploy/data/<id>.json (host path).
  const jsonHostFile = `data/${id}.json`; // relative to deploy/ for compose
  const jsonAbsDir = `${env.MCP_REPO_DIR}/deploy/data`;
  const jsonAbsFile = `${jsonAbsDir}/${id}.json`;
  const jsonAbsMeta = `${jsonAbsDir}/${id}.source.json`;

  if (body.type === "json") {
    asRoot(`mkdir -p ${jsonAbsDir}`);

    // Priority: jsonUrl, then jsonInline, else keep existing (or create empty {}).
    if (body.jsonUrl && body.jsonUrl.trim()) {
      let u: URL;
      try {
        u = new URL(body.jsonUrl.trim());
      } catch {
        reply.code(400);
        return { error: "bad jsonUrl" };
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        reply.code(400);
        return { error: "jsonUrl must be http(s)" };
      }

      let meta: any = null;
      if (fs.existsSync(jsonAbsMeta)) {
        try {
          meta = JSON.parse(fs.readFileSync(jsonAbsMeta, "utf8"));
        } catch {
          meta = null;
        }
      }

      const hdrs: Record<string, string> = {
        accept: "application/json",
        "user-agent": "justgpt-control-plane/0.1.0",
      };
      if (meta && meta.url === u.toString()) {
        if (meta.etag) hdrs["if-none-match"] = String(meta.etag);
        if (meta.lastModified) hdrs["if-modified-since"] = String(meta.lastModified);
      }

      const fr = await fetchJsonText(u.toString(), hdrs);
      if (fr.status === 304 && fs.existsSync(jsonAbsFile)) {
        // cache hit
        const m2 = {
          ...(meta || {}),
          url: u.toString(),
          fetchedAt: new Date().toISOString(),
          status: 304,
        };
        fs.writeFileSync(jsonAbsMeta, JSON.stringify(m2, null, 2) + "\n");
      } else if (fr.status === 200 && fr.text !== null) {
        let parsed: any;
        try {
          parsed = JSON.parse(fr.text);
        } catch {
          reply.code(400);
          return { error: "jsonUrl did not return valid JSON" };
        }
        const out = JSON.stringify(parsed, null, 2) + "\n";
        fs.writeFileSync(jsonAbsFile, out);
        const m2 = {
          url: u.toString(),
          fetchedAt: new Date().toISOString(),
          status: 200,
          bytes: Buffer.byteLength(out, "utf8"),
          sha256: sha256Hex(out),
          etag: fr.headers.get("etag"),
          lastModified: fr.headers.get("last-modified"),
        };
        fs.writeFileSync(jsonAbsMeta, JSON.stringify(m2, null, 2) + "\n");
      } else {
        reply.code(502);
        return { error: `jsonUrl fetch failed: status ${fr.status}` };
      }
    } else if (body.jsonInline && body.jsonInline.trim()) {
      let parsed: any;
      try {
        parsed = JSON.parse(body.jsonInline);
      } catch {
        reply.code(400);
        return { error: "bad jsonInline (must be valid JSON)" };
      }
      const out = JSON.stringify(parsed, null, 2) + "\n";
      if (Buffer.byteLength(out, "utf8") > JSON_MAX_BYTES) {
        reply.code(413);
        return { error: `json too large (max ${JSON_MAX_BYTES})` };
      }
      fs.writeFileSync(jsonAbsFile, out);
      const m2 = {
        url: null,
        fetchedAt: new Date().toISOString(),
        status: 200,
        bytes: Buffer.byteLength(out, "utf8"),
        sha256: sha256Hex(out),
        source: "inline",
      };
      fs.writeFileSync(jsonAbsMeta, JSON.stringify(m2, null, 2) + "\n");
    } else if (!fs.existsSync(jsonAbsFile)) {
      fs.writeFileSync(jsonAbsFile, "{}\n");
      const m2 = {
        url: null,
        fetchedAt: new Date().toISOString(),
        status: 200,
        bytes: 3,
        sha256: sha256Hex("{}\n"),
        source: "empty",
      };
      fs.writeFileSync(jsonAbsMeta, JSON.stringify(m2, null, 2) + "\n");
    }
  }

  // Generate project files via mcp-service init only if missing (idempotent deploy).
  if (!fs.existsSync(files.project) || !fs.existsSync(files.compose)) {
    const jsonArg = body.type === "json" ? ` --json-file ./${jsonHostFile}` : "";
    host(
      `npm install --silent >/dev/null 2>&1 || true; ` +
        `npm run build >/dev/null 2>&1; ` +
        `node dist/cli.js init --id ${id} --type ${body.type} --path ${mcpPath}${jsonArg} --no-update-env-example --no-update-nginx`,
    );
  }
  if (!fs.existsSync(files.project) || !fs.existsSync(files.compose)) {
    throw new Error("init did not produce expected files");
  }

  // Ensure token in deploy/.env
  const existingToken = readEnvValue(env.MCP_ENV_FILE, tokenEnv);
  const token = existingToken || randToken();
  const tokenCreated = !existingToken;
  if (tokenCreated) ensureEnvLine(env.MCP_ENV_FILE, tokenEnv, token);

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
    token: tokenCreated ? token : null,
    nginxChanged,
  };
});

app.setErrorHandler((err: any, _req, reply) => {
  const code = Number(err?.statusCode) || 500;
  reply.code(code);
  reply.send({ error: String(err?.message || err) });
});

app.listen({ port: env.PORT, host: env.HOST });
