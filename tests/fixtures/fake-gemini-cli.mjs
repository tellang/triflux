#!/usr/bin/env node

const args = process.argv.slice(2);

function getArgValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});

process.stdin.on('end', async () => {
  const promptText = `${stdin}${getArgValue('--prompt') || ''}`.trim();
  const model = getArgValue('--model') || 'fake-gemini-model';
  const outputFormat = getArgValue('--output-format');

  if (process.env.FAKE_GEMINI_EXIT_CODE) {
    process.stderr.write('fake gemini failure\n');
    process.exit(Number(process.env.FAKE_GEMINI_EXIT_CODE));
    return;
  }

  if (process.env.FAKE_GEMINI_DELAY_MS) {
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_GEMINI_DELAY_MS)));
  }

  if (outputFormat !== 'stream-json') {
    process.stderr.write('expected stream-json\n');
    process.exit(2);
    return;
  }

  process.stdout.write(`${JSON.stringify({ type: 'init', model })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `gemini:${promptText}` }],
    },
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'result',
    response: `gemini:${promptText}`,
    usage: { totalTokens: promptText.length },
  })}\n`);
});
