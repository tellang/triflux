import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// agy 상태줄(HUD)이 남긴 컨텍스트 사용 기록을 tfx-live 가 대화 ID 로 읽는다.
const CONVERSATION_ID = /^[0-9a-zA-Z-]+$/;

export function agyContextDir(env = process.env) {
  return join(
    env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"),
    "triflux",
    "agy-context",
  );
}

export function writeAgyContext(
  { conversationId, usedPercentage, windowSize, usedTokens, model },
  { env = process.env, now = Date.now } = {},
) {
  if (!CONVERSATION_ID.test(conversationId || "")) return false;
  try {
    const dir = agyContextDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, `${conversationId}.json`);
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify({
        conversationId,
        usedPercentage,
        windowSize,
        usedTokens,
        model,
        recordedAt: new Date(now()).toISOString(),
      }),
      { mode: 0o600 },
    );
    renameSync(temp, target);
    return true;
  } catch {
    // 상태줄 출력이 컨텍스트 기록 실패로 늦어지거나 깨지면 안 된다.
    return false;
  }
}

// modelContext 와 같은 필드 이름으로 돌려준다. 기록이 없으면 null.
export function readAgyContext(conversationId, { env = process.env } = {}) {
  if (!CONVERSATION_ID.test(conversationId || "")) return null;
  try {
    const record = JSON.parse(
      readFileSync(join(agyContextDir(env), `${conversationId}.json`), "utf8"),
    );
    if (
      !Number.isFinite(record.usedPercentage) ||
      !(record.windowSize > 0) ||
      !Number.isFinite(record.usedTokens)
    )
      return null;
    return {
      estimatedContextTokens: record.usedTokens,
      contextLimitTokens: record.windowSize,
      contextLimitSource: "agy-statusline",
      contextPct: record.usedPercentage,
      contextRecordedAt: record.recordedAt ?? null,
      model: record.model ?? null,
    };
  } catch {
    return null;
  }
}
