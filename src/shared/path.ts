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
  if (p.startsWith("**/")) return normalized.endsWith(p.slice(3)) || normalized.includes(`/${p.slice(3)}`);
  if (p.endsWith("/**")) return normalized.startsWith(p.slice(0, -3));
  if (p.includes("*")) {
    const re = new RegExp(`^${p.split("*").map(escapeRegExp).join(".*")}$`);
    return re.test(normalized);
  }
  return normalized === p || normalized.endsWith(`/${p}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
