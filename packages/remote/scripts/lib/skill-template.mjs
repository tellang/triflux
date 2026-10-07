const FRONTMATTER_RE = /^---\r?\n(?:([\s\S]*?)\r?\n)?---\r?\n?/;

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

export function parseFrontmatter(source) {
  const match = source.match(FRONTMATTER_RE);
  if (!match) return { data: {}, body: source };

  const data = parseFrontmatterBlock(match[1] ?? "");
  const body = source.slice(match[0].length);
  return { data, body };
}
