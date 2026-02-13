import { z } from "zod";

export const ProjectType = z.enum(["json", "openapi", "postgres", "mysql"]);

export function validateProjectId(id: string) {
  const v = id.trim();
  if (!v) throw new Error("id не задан");
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(v)) {
    throw new Error("id должен быть в формате: [a-z0-9][a-z0-9_-]*");
  }
  return v;
}

export function tokenEnvForProjectId(id: string) {
  return `MCP_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BEARER_TOKEN`;
}
