import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSkillTemplateContext,
  loadTemplatePartials,
  parseFrontmatter,
  renderSkillTemplate,
} from "./lib/skill-template.mjs";

function walkFiles(rootDir, currentDir = rootDir) {
  const entries = readdirSync(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      files.push(...walkFiles(rootDir, fullPath));
      continue;
    }

    if (!entry.isFile()) continue;
    files.push(fullPath);
  }

  return files;
}

function collectSkillTemplateFiles(skillsDir) {
  return walkFiles(skillsDir)
    .filter((file) => file.endsWith("SKILL.md.tmpl"))
    .filter(
      (file) =>
        !relative(skillsDir, file)
          .replace(/\\/g, "/")
          .startsWith("_templates/"),
    )
    .sort((left, right) => left.localeCompare(right));
}

function resolveOutputPath(templatePath) {
  if (!templatePath.endsWith(".tmpl")) {
    throw new Error(`Template file must end with .tmpl: ${templatePath}`);
  }
  return templatePath.slice(0, -".tmpl".length);
}

function createRenderContext(templateContent, templatePath) {
  const { data: frontmatter } = parseFrontmatter(templateContent);
  const skillDirName = dirname(templatePath).split(/[/\\]/).pop() || "";
  return buildSkillTemplateContext({ frontmatter, skillDirName });
}

export function generateSkillDocs({
  skillsDir,
  templatesDir = join(skillsDir, "_templates"),
  write = true,
} = {}) {
  if (!skillsDir) throw new Error("skillsDir is required");

  const partials = loadTemplatePartials(templatesDir);
  const templateFiles = collectSkillTemplateFiles(skillsDir);
  const generated = [];

  for (const templatePath of templateFiles) {
    const templateContent = readFileSync(templatePath, "utf8");
    const context = createRenderContext(templateContent, templatePath);
    const rendered = renderSkillTemplate(templateContent, context, {
      partials,
      includeBaseDir: skillsDir,
    });
    const outputPath = resolveOutputPath(templatePath);

    if (write) {
      writeFileSync(outputPath, rendered, "utf8");
    }

    generated.push({
      templatePath,
      outputPath,
      relativeTemplatePath: relative(skillsDir, templatePath).replace(
        /\\/g,
        "/",
      ),
      context,
      rendered,
    });
  }

  return {
    generated,
    count: generated.length,
  };
}

function runCli() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const skillsDir = join(repoRoot, "skills");

  const result = generateSkillDocs({ skillsDir });
  console.log(`Generated ${result.count} SKILL.md file(s) from templates.`);
}

const isDirectRun = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  try {
    runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[gen-skill-docs] ${message}`);
    process.exitCode = 1;
  }
}
