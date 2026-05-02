/**
 * Deterministic YAML emitter for contract registry artifacts.
 *
 * Hand-rolled to avoid an external dependency. Supports the JSON-compatible
 * subset (string/number/boolean/null/array/object) which is sufficient for
 * the contract YAML shape described in docs/indexing.md V0.2.
 */

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue | undefined };

export function emitYaml(value: YamlValue): string {
  const lines: string[] = [];
  emitValue(value, 0, lines, "root");
  return `${lines.join("\n")}\n`;
}

function emitValue(value: YamlValue | undefined, indent: number, lines: string[], context: "root" | "block" | "list"): void {
  if (value === undefined || value === null) {
    if (context === "list") lines.push(`${pad(indent)}- null`);
    else lines[lines.length - 1] = `${lines[lines.length - 1] ?? ""} null`.replace(/\s+/, " ").trimEnd();
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      appendInline(lines, indent, context, "[]");
      return;
    }
    finishHeaderForBlock(lines, context);
    for (const item of value) emitListItem(item, indent, lines);
    return;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) {
      appendInline(lines, indent, context, "{}");
      return;
    }
    finishHeaderForBlock(lines, context);
    for (const [key, item] of entries) emitMapEntry(key, item as YamlValue, indent, lines);
    return;
  }

  appendInline(lines, indent, context, formatScalar(value));
}

function emitMapEntry(key: string, value: YamlValue, indent: number, lines: string[]): void {
  const safeKey = formatKey(key);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad(indent)}${safeKey}: []`);
      return;
    }
    lines.push(`${pad(indent)}${safeKey}:`);
    for (const item of value) emitListItem(item, indent + 1, lines);
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) {
      lines.push(`${pad(indent)}${safeKey}: {}`);
      return;
    }
    lines.push(`${pad(indent)}${safeKey}:`);
    for (const [nestedKey, nestedValue] of entries) emitMapEntry(nestedKey, nestedValue as YamlValue, indent + 1, lines);
    return;
  }
  lines.push(`${pad(indent)}${safeKey}: ${formatScalar(value as string | number | boolean | null)}`);
}

function emitListItem(value: YamlValue, indent: number, lines: string[]): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad(indent)}- []`);
      return;
    }
    lines.push(`${pad(indent)}-`);
    for (const item of value) emitListItem(item, indent + 1, lines);
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) {
      lines.push(`${pad(indent)}- {}`);
      return;
    }
    const [firstKey, firstValue] = entries[0];
    const remaining = entries.slice(1);
    if (Array.isArray(firstValue) || (firstValue && typeof firstValue === "object")) {
      lines.push(`${pad(indent)}-`);
      emitMapEntry(firstKey, firstValue as YamlValue, indent + 1, lines);
    } else {
      lines.push(`${pad(indent)}- ${formatKey(firstKey)}: ${formatScalar(firstValue as string | number | boolean | null)}`);
    }
    for (const [key, item] of remaining) emitMapEntry(key, item as YamlValue, indent + 1, lines);
    return;
  }
  lines.push(`${pad(indent)}- ${formatScalar(value as string | number | boolean | null)}`);
}

function appendInline(lines: string[], indent: number, context: "root" | "block" | "list", text: string): void {
  if (context === "list") {
    lines.push(`${pad(indent)}- ${text}`);
    return;
  }
  if (lines.length === 0) {
    lines.push(text);
    return;
  }
  const last = lines[lines.length - 1];
  lines[lines.length - 1] = last.endsWith(":") ? `${last} ${text}` : text;
}

function finishHeaderForBlock(_lines: string[], _context: "root" | "block" | "list"): void {
  // No-op; map/list rendering uses explicit indentation through emitMapEntry/emitListItem.
}

function pad(indent: number): string {
  return "  ".repeat(indent);
}

function formatKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_\-./]*$/.test(key) ? key : JSON.stringify(key);
}

function formatScalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  return formatString(value);
}

function formatString(value: string): string {
  if (value === "") return '""';
  if (needsQuoting(value)) return JSON.stringify(value);
  return value;
}

const RESERVED_PLAIN = new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]);

function needsQuoting(value: string): boolean {
  if (RESERVED_PLAIN.has(value.toLowerCase())) return true;
  if (/^[-+]?\d/.test(value)) return true;
  if (/[:#\n\r\t"'`{}\[\],&*!|>%@]/.test(value)) return true;
  if (value.startsWith(" ") || value.endsWith(" ")) return true;
  return false;
}
