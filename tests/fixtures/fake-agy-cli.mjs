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

// agy 1.1.27 semantics: --print takes the prompt as its value (the next argv
// token, or --print=VALUE). A bare trailing --print is rejected, and stdin is
// never used for the prompt.
function parsePrintValue(argv) {
  const eq = argv.find((a) => a.startsWith("--print="));
  if (eq) return eq.slice("--print=".length);
  const i = argv.indexOf("--print");
  if (i === -1) return null;
  if (i === argv.length - 1) {
    process.stderr.write("flag needs an argument: -print\n");
    process.exit(2);
  }
  return argv[i + 1];
}

function main() {
  if (process.env.FAKE_AGY_EXIT_CODE) {
    process.stderr.write("fake agy failure\n");
    process.exit(Number(process.env.FAKE_AGY_EXIT_CODE));
    return;
  }

  const printValue = parsePrintValue(args);
  if (printValue === null) {
    process.stderr.write("expected --print\n");
    process.exit(2);
    return;
  }

  if (!args.includes("--dangerously-skip-permissions")) {
    process.stderr.write("expected --dangerously-skip-permissions\n");
    process.exit(3);
    return;
  }

  const prompt = printValue.trim();
  if (!prompt) {
    process.stderr.write('Error: Error: empty prompt. Usage: agy --print "your prompt here"\n');
    process.exit(4);
    return;
  }

  if (prompt.includes("Return exactly: AGY_OK")) {
    process.stdout.write("AGY_OK\n");
    return;
  }

  process.stdout.write(`AGY:${prompt}\n`);
}

main();
