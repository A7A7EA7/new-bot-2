import { defineConfig } from "drizzle-kit";
import path from "path";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

function findWorkspaceRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function resolveDbPath(): string {
  const raw = process.env.DATABASE_URL?.trim();
  if (raw && !/^postgres(ql)?:\/\//i.test(raw)) {
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  }
  const root = findWorkspaceRoot(process.cwd());
  return resolve(root, "data", "bot.db");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "sqlite",
  dbCredentials: {
    url: resolveDbPath(),
  },
});
