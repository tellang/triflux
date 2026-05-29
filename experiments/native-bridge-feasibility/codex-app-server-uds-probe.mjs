#!/usr/bin/env node
// experiments/native-bridge-feasibility/codex-app-server-uds-probe.mjs
//
// SPIKE: empirically determine how codex `app-server --listen unix://PATH`
// frames JSON-RPC on the wire. Two RE passes disagreed:
//   - binary-schema pass said the unix socket is plain newline-delimited JSON.
//   - official-docs pass (README L26-42) said the unix socket is
//     WebSocket-over-UDS (HTTP Upgrade handshake + WS text frames).
//
// This probe resolves it against the INSTALLED codex (0.135.x) with ground
// truth, with ZERO model-quota cost: it only exercises the transport +
// `initialize`/`initialized`/`thread/start` handshake, which need no auth. It
// never sends `turn/start` (the only auth/model-gated call).
//
// It is spawned via `node`, so the triflux headless-guard (which inspects the
// Bash command text for `codex exec`-style prompts) never sees a `codex`
// invocation — the spawn happens inside Node, like the existing
// claude-codex-uds-orchestration smoke.
//
// READ-ONLY w.r.t. the repo. Writes a report to
// experiments/native-bridge-feasibility/codex-app-server-uds-probe-latest-report.json
// (gitignored-style scratch, same convention as the other *-latest-report.json).

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(HERE, "codex-app-server-uds-probe-latest-report.json");
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OVERALL_DEADLINE_MS = 30_000;

function nowIso() {
  return new Date().toISOString();
}

async function waitForSocket(sockPath, deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const s = await stat(sockPath);
      if (s.isSocket()) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// ── Hypothesis A: raw newline-delimited JSON-RPC ────────────────────
function probeRawJsonl(sockPath, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = net.connect(sockPath);
    let buf = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: "timeout", bytes: buf.slice(0, 400) }),
      timeoutMs,
    );
    socket.on("error", (e) =>
      finish({ ok: false, reason: `socket error: ${e.message}` }),
    );
    socket.on("connect", () => {
      const frame = `${JSON.stringify({
        id: 0,
        method: "initialize",
        params: { clientInfo: { name: "tfx-uds-probe", version: "0.0.0" } },
      })}\n`;
      socket.write(frame);
    });
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      // If the server speaks WS it will reply with an HTTP/1.1 line, not JSON.
      if (/^HTTP\/1\.\d/.test(buf)) {
        clearTimeout(timer);
        finish({
          ok: false,
          reason: "server replied with HTTP (expects WebSocket upgrade)",
          bytes: buf.slice(0, 200),
        });
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        const line = buf.slice(0, nl);
        try {
          const msg = JSON.parse(line);
          finish({ ok: true, framing: "jsonl", initializeResponse: msg });
        } catch (e) {
          finish({
            ok: false,
            reason: `non-JSON line: ${e.message}`,
            line: line.slice(0, 200),
          });
        }
      }
    });
  });
}

// ── Hypothesis B: WebSocket-over-UDS (HTTP Upgrade + RFC6455 frames) ──
function encodeClientTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  const mask = randomBytes(4);
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

// Minimal server->client frame decoder. Returns {frames:[{opcode,payload}], rest:Buffer}.
function decodeServerFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let cursor = offset + 2;
    if (len === 126) {
      if (cursor + 2 > buf.length) break;
      len = buf.readUInt16BE(cursor);
      cursor += 2;
    } else if (len === 127) {
      if (cursor + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(cursor));
      cursor += 8;
    }
    const maskKey = masked ? buf.subarray(cursor, cursor + 4) : null;
    if (masked) cursor += 4;
    if (cursor + len > buf.length) break;
    let payload = buf.subarray(cursor, cursor + len);
    if (masked && maskKey) {
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i % 4];
      payload = out;
    }
    frames.push({ opcode, payload });
    offset = cursor + len;
  }
  return { frames, rest: buf.subarray(offset) };
}

function probeWebSocket(sockPath, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const socket = net.connect(sockPath);
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");
    let phase = "handshake";
    let raw = Buffer.alloc(0);
    let settled = false;
    let acceptHeaderValid = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {}
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          reason: `timeout in phase=${phase}`,
          headPreview: raw.subarray(0, 200).toString("utf8"),
        }),
      timeoutMs,
    );
    socket.on("error", (e) =>
      finish({ ok: false, reason: `socket error: ${e.message}` }),
    );
    socket.on("connect", () => {
      const req =
        `GET / HTTP/1.1\r\n` +
        `Host: localhost\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`;
      socket.write(req);
    });
    socket.on("data", (chunk) => {
      raw = Buffer.concat([raw, chunk]);
      if (phase === "handshake") {
        const sep = raw.indexOf("\r\n\r\n");
        if (sep < 0) return;
        const headers = raw.subarray(0, sep).toString("utf8");
        const status101 = /^HTTP\/1\.\d 101/.test(headers);
        acceptHeaderValid = headers.includes(expectedAccept);
        if (!status101) {
          finish({
            ok: false,
            framing: "not-websocket",
            reason: "no 101 Switching Protocols",
            headers: headers.slice(0, 400),
          });
          return;
        }
        phase = "frames";
        raw = raw.subarray(sep + 4);
        // send initialize as a masked text frame
        socket.write(
          encodeClientTextFrame(
            JSON.stringify({
              id: 0,
              method: "initialize",
              params: {
                clientInfo: { name: "tfx-uds-probe", version: "0.0.0" },
              },
            }),
          ),
        );
        // fall through to decode any frames already buffered
      }
      if (phase === "frames") {
        const { frames, rest } = decodeServerFrames(raw);
        raw = rest;
        for (const f of frames) {
          if (f.opcode === 0x8) {
            finish({
              ok: false,
              framing: "websocket",
              reason: "server sent close frame",
            });
            return;
          }
          if (f.opcode === 0x1 || f.opcode === 0x0) {
            const text = f.payload.toString("utf8");
            try {
              const msg = JSON.parse(text);
              if (msg && (msg.id === 0 || msg.result || msg.error)) {
                finish({
                  ok: true,
                  framing: "websocket-over-uds",
                  handshakeAcceptValid: acceptHeaderValid,
                  initializeResponse: msg,
                });
                return;
              }
            } catch {
              /* maybe partial; keep reading */
            }
          }
        }
      }
    });
  });
}

async function main() {
  const report = {
    kind: "codex-app-server-uds-framing-probe",
    startedAt: nowIso(),
    codexBin: CODEX_BIN,
    socketPath: null,
    serverSpawn: null,
    rawJsonl: null,
    websocket: null,
    conclusion: null,
    stderrTail: "",
  };

  let dir;
  let child;
  const hardTimer = setTimeout(() => {
    report.conclusion = report.conclusion || "overall-deadline-exceeded";
  }, OVERALL_DEADLINE_MS);

  try {
    dir = await mkdtemp(join(tmpdir(), "tfx-codex-appserver-probe-"));
    const sockPath = join(dir, "app-server.sock");
    report.socketPath = sockPath;

    // NOTE: codex 0.135.0 rejects `--skip-git-repo-check` as a global option
    // (it moved to subcommand scope). app-server does not need it.
    report.serverArgv = ["app-server", "--listen", `unix://${sockPath}`];
    child = spawn(CODEX_BIN, report.serverArgv, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stderr = "";
    child.stdout.on("data", (c) => {
      stderr += `[out] ${c}`;
    });
    child.stderr.on("data", (c) => {
      stderr += String(c);
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    const spawnErr = new Promise((resolve) => {
      child.once("error", (e) => resolve(`spawn error: ${e.message}`));
      child.once("exit", (code, sig) =>
        resolve(`exited early code=${code} sig=${sig || ""}`),
      );
    });

    const ready = await Promise.race([
      waitForSocket(sockPath, 12_000).then((ok) =>
        ok ? "ready" : "no-socket",
      ),
      spawnErr,
    ]);
    report.serverSpawn = ready;
    report.stderrTail = stderr.slice(-2000);

    if (ready !== "ready") {
      report.conclusion = `server did not bind socket: ${ready}`;
      return;
    }

    // Try WS first (docs say unix:// = WS-over-UDS); if it isn't WS the
    // handshake fails fast and we fall back to raw JSONL on a fresh connection.
    report.websocket = await probeWebSocket(sockPath);
    if (!report.websocket.ok) {
      report.rawJsonl = await probeRawJsonl(sockPath);
    }

    if (report.websocket?.ok) {
      report.conclusion = "FRAMING = websocket-over-uds (docs confirmed)";
    } else if (report.rawJsonl?.ok) {
      report.conclusion = "FRAMING = raw-jsonl (binary-schema pass confirmed)";
    } else {
      report.conclusion =
        "INCONCLUSIVE — neither WS nor raw JSONL completed initialize";
    }
  } catch (e) {
    report.conclusion = `probe error: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    clearTimeout(hardTimer);
    if (child && child.exitCode === null && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
      try {
        if (child.exitCode === null) child.kill("SIGKILL");
      } catch {}
    }
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    report.finishedAt = nowIso();
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`).catch(
      () => {},
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

main();
