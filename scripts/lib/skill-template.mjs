import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

const IF_TAG_RE = /{{\s*(#if\s+([A-Za-z0-9_.-]+)|\/if)\s*}}/g;
const PARTIAL_RE = /{{>\s*([A-Za-z0-9_./-]+)\s*}}/g;
const FILE_INCLUDE_RE = /{{#include\s+([A-Za-z0-9_./-]+)\s*}}/g;
const VARIABLE_RE = /{{\s*([A-Za-z0-9_.-]+)\s*}}/g;
const FRONTMATTER_RE = /^---\r?\n(?:([\s\S]*?)\r?\n)?---\r?\n?/;

function isTruthy(value) {
  if (typeof value === "string") return value.trim().length > 0;
  return Boolean(value);
}

function normalizeVariable(context, key) {
  if (Object.hasOwn(context, key)) return context[key];
  const upper = key.toUpperCase();
  if (Object.hasOwn(context, upper)) return context[upper];
  return undefined;
}

function parseBoolean(raw) {
  if (typeof raw !== "string") return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

function parseScalar(raw) {
  if (raw == null) return "";
  const value = raw.trim();
  if (!value) return "";
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  const bool = parseBoolean(value);
  return bool ?? value;
}

function parseMultilineValue(lines, startIndex, marker) {
  const fold = marker.startsWith(">");
  const chunks = [];
  let index = startIndex;

  while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
    index += 1;
    chunks.push(lines[index].replace(/^\s+/, ""));
  }

  return {
    index,
    value: fold ? chunks.join(" ").trim() : chunks.join("\n").trim(),
  };
}

function parseListValue(lines, startIndex) {
  const items = [];
  let index = startIndex;

  while (index + 1 < lines.length) {
    const nextLine = lines[index + 1];
    const match = nextLine.match(/^\s*-\s+(.*)$/);
    if (match) {
      index += 1;
      items.push(parseScalar(match[1]));
      continue;
    }
    if (/^\s*$/.test(nextLine)) {
      index += 1;
      continue;
    }
    break;
  }

  return { index, value: items };
}

function parseFrontmatterBlock(block) {
  const lines = block.split(/\r?\n/);
  const data = {};

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;

    const [, rawKey, rawValue] = match;
    const key = rawKey.trim();
    const value = rawValue.trim();

    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const parsed = parseMultilineValue(lines, i, value);
      data[key] = parsed.value;
      i = parsed.index;
      continue;
    }

    if (!value) {
      const parsed = parseListValue(lines, i);
      if (parsed.index !== i) {
        data[key] = parsed.value;
        i = parsed.index;
        continue;
      }
    }

    data[key] = parseScalar(value);
  }

  return data;
}

function evaluateConditionals(source, context) {
  const matcher = new RegExp(IF_TAG_RE.source, "g");

  function walk(startIndex, nested) {
    let output = "";
    let cursor = startIndex;

    while (true) {
      const found = matcher.exec(source);
      if (!found) {
        if (nested) throw new Error("Unclosed {{#if ...}} block in template");
        output += source.slice(cursor);
        return { output, index: source.length };
      }

      output += source.slice(cursor, found.index);
      cursor = matcher.lastIndex;

      const directive = found[1];
      const flag = found[2];
      if (directive.startsWith("#if")) {
        const nestedResult = walk(cursor, true);
        cursor = nestedResult.index;
        matcher.lastIndex = cursor;
        if (isTruthy(normalizeVariable(context, flag))) {
          output += nestedResult.output;
        }
        continue;
      }

      if (!nested) {
        throw new Error("Unexpected {{/if}} without matching {{#if ...}}");
      }
      return { output, index: cursor };
    }
  }

  return walk(0, false).output;
}

function renderPartials(source, context, partials, options, includeStack) {
  return source.replace(PARTIAL_RE, (_full, partialName) => {
    const partial = partials[partialName];
    if (partial == null) {
      throw new Error(`Missing partial: ${partialName}`);
    }
    if (includeStack.includes(partialName)) {
      const chain = [...includeStack, partialName].join(" -> ");
      throw new Error(`Circular partial include: ${chain}`);
    }
    return renderWithContext(partial, context, partials, options, [
      ...includeStack,
      partialName,
    ]);
  });
}

function normalizeIncludeName(includeName) {
  return includeName.replace(/\\/g, "/");
}

function resolveIncludeContent(includeName, options) {
  const normalizedName = normalizeIncludeName(includeName);
  if (Object.hasOwn(options.includes, normalizedName)) {
    return options.includes[normalizedName];
  }
  if (!options.includeBaseDir) {
    throw new Error(`Missing include: ${normalizedName}`);
  }

  const baseDir = resolve(options.includeBaseDir);
  const fullPath = resolve(baseDir, normalizedName);
  const relativePath = relative(baseDir, fullPath);
  const isInsideBaseDir =
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath));

  if (!isInsideBaseDir || !existsSync(fullPath)) {
    throw new Error(`Missing include: ${normalizedName}`);
  }

  const content = readFileSync(fullPath, "utf8");
  options.includes[normalizedName] = content;
  return content;
}

function renderFileIncludes(source, context, partials, options, includeStack) {
  return source.replace(FILE_INCLUDE_RE, (_full, includeName) => {
    const normalizedName = normalizeIncludeName(includeName);
    const content = resolveIncludeContent(normalizedName, options);
    if (includeStack.includes(normalizedName)) {
      const chain = [...includeStack, normalizedName].join(" -> ");
      throw new Error(`Circular template include: ${chain}`);
    }
    return renderWithContext(content, context, partials, options, [
      ...includeStack,
      normalizedName,
    ]);
  });
}

function renderVariables(source, context) {
  return source.replace(VARIABLE_RE, (full, key) => {
    const value = normalizeVariable(context, key);
    if (value == null) {
      throw new Error(`Missing template variable: ${key}`);
    }
    return String(value);
  });
}

function renderWithContext(
  source,
  context,
  partials,
  options,
  includeStack = [],
) {
  const afterIf = evaluateConditionals(source, context);
  const afterPartials = renderPartials(
    afterIf,
    context,
    partials,
    options,
    includeStack,
  );
  const afterFileIncludes = renderFileIncludes(
    afterPartials,
    context,
    partials,
    options,
    includeStack,
  );
  return renderVariables(afterFileIncludes, context);
}

function readAllTemplateFiles(rootDir, currentDir = rootDir) {
  if (!rootDir || !existsSync(rootDir)) return [];

  const entries = readdirSync(currentDir, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  const files = [];

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...readAllTemplateFiles(rootDir, fullPath));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md") && !entry.name.endsWith(".tmpl")) continue;

    const relativePath = relative(rootDir, fullPath).replace(/\\/g, "/");
    const content = readFileSync(fullPath, "utf8");
    files.push({ fullPath, relativePath, content });
  }

  return files;
}

function setPartial(partials, key, value) {
  if (!key) return;
  if (!Object.hasOwn(partials, key)) {
    partials[key] = value;
  }
}

export function parseFrontmatter(source) {
  const match = source.match(FRONTMATTER_RE);
  if (!match) return { data: {}, body: source };

  const data = parseFrontmatterBlock(match[1] ?? "");
  const body = source.slice(match[0].length);
  return { data, body };
}

export function buildSkillTemplateContext({
  frontmatter = {},
  skillDirName = "",
} = {}) {
  const context = { ...frontmatter };
  const skillName = String(frontmatter.name || skillDirName || "").trim();
  const skillDescription = String(frontmatter.description || "").trim();

  let deep = frontmatter.DEEP ?? frontmatter.deep;
  if (typeof deep === "string") {
    const parsed = parseBoolean(deep.trim().toLowerCase());
    deep = parsed ?? deep;
  }
  if (typeof deep !== "boolean") {
    deep = /(^|[-_])deep($|[-_])/i.test(skillName);
  }

  context.SKILL_NAME = skillName;
  context.SKILL_DESCRIPTION = skillDescription;
  context.DEEP = deep;
  return context;
}

export function loadTemplatePartials(partialsDir) {
  const files = readAllTemplateFiles(partialsDir);
  const partials = {};

  for (const file of files) {
    const extension = extname(file.relativePath);
    const withoutExt = extension
      ? file.relativePath.slice(0, -extension.length)
      : file.relativePath;
    const normalized = withoutExt.replace(/\\/g, "/");
    const base = basename(normalized);

    setPartial(partials, normalized, file.content);
    setPartial(partials, base, file.content);
  }

  return partials;
}

export function loadSkillManifest(skillDir) {
  const manifestPath = join(skillDir, "skill.json");
  if (!existsSync(manifestPath)) return null;

  const raw = readFileSync(manifestPath, "utf8");
  return JSON.parse(raw);
}

export function parseFrontmatterWithManifest(source, skillDir) {
  const manifest = skillDir ? loadSkillManifest(skillDir) : null;
  const { data: yamlData, body } = parseFrontmatter(source);

  if (!manifest) return { data: yamlData, body };

  const merged = { ...yamlData };
  if (manifest.name) merged.name = manifest.name;
  if (manifest.description) merged.description = manifest.description;
  if (manifest.triggers) merged.triggers = manifest.triggers;
  if (manifest.argument_hint) merged["argument-hint"] = manifest.argument_hint;
  if (manifest.internal != null) merged.internal = manifest.internal;

  return { data: merged, body };
}

export function renderSkillTemplate(template, context = {}, options = {}) {
  const { partials = {}, includes = {}, includeBaseDir = "" } = options;
  return renderWithContext(template, context, partials, {
    includeBaseDir,
    includes: { ...includes },
  });
}
