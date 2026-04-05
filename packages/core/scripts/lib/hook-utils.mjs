export function nudge(message) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: message,
    },
  }));
  process.exit(0);
}

export function deny(reason) {
  process.stderr.write(reason);
  process.exit(2);
}
