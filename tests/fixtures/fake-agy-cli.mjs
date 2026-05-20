#!/usr/bin/env node
const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write("1.0.0\n");
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      "Usage: agy [options]",
      "  -p, --print",
      "  --prompt <prompt>",
      "  --dangerously-skip-permissions",
      "  -c, --continue",
      "  --conversation <id>",
      "  --add-dir <dir>",
      "  --print-timeout <duration>",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});

process.stdin.on("end", () => {
  if (process.env.FAKE_AGY_EXIT_CODE) {
    process.stderr.write("fake agy failure\n");
    process.exit(Number(process.env.FAKE_AGY_EXIT_CODE));
    return;
  }

  if (!args.includes("--print")) {
    process.stderr.write("expected --print\n");
    process.exit(2);
    return;
  }

  if (!args.includes("--dangerously-skip-permissions")) {
    process.stderr.write("expected --dangerously-skip-permissions\n");
    process.exit(3);
    return;
  }

  const prompt = stdin.trim();
  if (!prompt) {
    process.stderr.write("expected prompt on stdin\n");
    process.exit(4);
    return;
  }

  if (prompt.includes("Return exactly: AGY_OK")) {
    process.stdout.write("AGY_OK\n");
    return;
  }

  process.stdout.write(`AGY:${prompt}\n`);
});
