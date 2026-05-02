import path from "node:path";

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "root";
}

export function toAbs(baseDir: string, target: string): string {
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(baseDir, target);
}

export function toRelOrAbs(baseDir: string, targetAbs: string): string {
  const rel = path.relative(baseDir, targetAbs);
  return rel.startsWith("..") ? targetAbs : rel || ".";
}

export function isInside(parentAbs: string, childAbs: string): boolean {
  const rel = path.relative(parentAbs, childAbs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function refOf(root: string, relPath: string): string {
  return `${root}:${relPath.replaceAll(path.sep, "/")}`;
}

export function parseRef(ref: string): { root: string; relPath: string } | undefined {
  const idx = ref.indexOf(":");
  if (idx <= 0) return undefined;
  return { root: ref.slice(0, idx), relPath: ref.slice(idx + 1) };
}

export function globishMatch(pattern: string, file: string): boolean {
  const normalized = file.replaceAll(path.sep, "/");
  const p = pattern.replaceAll(path.sep, "/");
  if (!p.includes("*")) return normalized === p || normalized.endsWith(`/${p}`);
  return globToRegExp(p).test(normalized);
}

function globToRegExp(pattern: string): RegExp {
  let body = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    const next = pattern[i + 1];
    if (ch === "*" && next === "*") {
      const after = pattern[i + 2];
      if (after === "/") {
        body += "(?:.*/)?";
        i += 2;
        continue;
      }
      body += ".*";
      i += 1;
      continue;
    }
    if (ch === "*") {
      body += "[^/]*";
      continue;
    }
    if (ch === "?") {
      body += "[^/]";
      continue;
    }
    body += escapeRegExp(ch);
  }
  return new RegExp(`^${body}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
