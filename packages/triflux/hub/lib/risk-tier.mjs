export const HIGH_PATTERNS = Object.freeze([
  /^hub\//,
  /^scripts\//,
  /^\.claude\/rules\//,
  /^bin\//,
  /^\.github\//,
]);

export const MEDIUM_PATTERNS = Object.freeze([
  /package\.json$/,
  /\.ya?ml$/,
  /\.toml$/,
  /^config\//,
  /^hooks\//,
]);

export const LOW_PATTERNS = Object.freeze([/\.md$/, /\.txt$/, /\.test\./]);

export function classifyRiskTier({ changedFiles }) {
  const files = Array.isArray(changedFiles)
    ? changedFiles.filter((file) => typeof file === "string" && file.length > 0)
    : [];

  if (files.length === 0) {
    return "low";
  }

  if (matchesAny(files, HIGH_PATTERNS)) {
    return "high";
  }

  if (files.length > 1) {
    return "medium";
  }

  if (matchesAny(files, MEDIUM_PATTERNS)) {
    return "medium";
  }

  if (matchesPattern(files[0], LOW_PATTERNS)) {
    return "low";
  }

  return "medium";
}

function matchesAny(files, patterns) {
  return files.some((file) => matchesPattern(file, patterns));
}

function matchesPattern(file, patterns) {
  return patterns.some((pattern) => pattern.test(file));
}
