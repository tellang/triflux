#!/usr/bin/env node

const args = process.argv.slice(2);

function getArgValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function getArgValues(name) {
  const index = args.indexOf(name);
  if (index < 0) return [];
  const values = [];
  for (let i = index + 1; i < args.length; i += 1) {
    if (args[i].startsWith('--')) break;
    values.push(args[i]);
  }
  return values;
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
  const allowedMcpServerNames = getArgValues('--allowed-mcp-server-names');

  if (process.env.FAKE_GEMINI_SILENT_CRASH) {
    // 출력 없이 즉시 종료 — health check crash 감지 테스트용
    process.exit(Number(process.env.FAKE_GEMINI_SILENT_CRASH));
    return;
  }

  if (process.env.FAKE_GEMINI_EXIT_CODE) {
    process.stderr.write('fake gemini failure\n');
    process.exit(Number(process.env.FAKE_GEMINI_EXIT_CODE));
    return;
  }

  if (process.env.FAKE_GEMINI_DELAY_MS) {
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_GEMINI_DELAY_MS)));
  }

  if (outputFormat !== 'stream-json' && !process.env.FAKE_GEMINI_LEGACY_OK) {
    process.stderr.write('expected stream-json\n');
    process.exit(2);
    return;
  }

  const responseText = process.env.FAKE_GEMINI_ECHO_ALLOWED_MCP === '1'
    ? `gemini:${promptText}\nallowed:${allowedMcpServerNames.join(',')}`
    : `gemini:${promptText}`;

  process.stdout.write(`${JSON.stringify({ type: 'init', model })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: responseText }],
    },
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'result',
    response: responseText,
    usage: { totalTokens: promptText.length },
  })}\n`);
});
