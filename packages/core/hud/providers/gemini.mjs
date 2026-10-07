import {
  ANTIGRAVITY_MODEL_ABBREV,
  ANTIGRAVITY_OAUTH_PATHS,
  ANTIGRAVITY_SETTINGS_PATH,
  GEMINI_OAUTH_PATH,
} from "../constants.mjs";
import { decodeJwtEmail, readJson } from "../utils.mjs";

function getCredentialEmail(credential) {
  return (
    decodeJwtEmail(credential?.id_token) ||
    credential?.email ||
    credential?.account?.email ||
    credential?.user?.email ||
    credential?.profile?.email ||
    null
  );
}

export function getGeminiEmail() {
  return getCredentialEmail(readJson(GEMINI_OAUTH_PATH, null));
}

// GCP 프로젝트 인증이면 계정 이메일 대신 프로젝트 ID를 보여 준다.
export function getAntigravityAccountLabel() {
  const project = readJson(ANTIGRAVITY_SETTINGS_PATH, null)?.gcp?.project;
  if (project) return project;
  for (const oauthPath of ANTIGRAVITY_OAUTH_PATHS) {
    try {
      const email = getCredentialEmail(readJson(oauthPath, null));
      if (email) return email;
    } catch {
      // 다음 Antigravity 인증 경로를 확인한다.
    }
  }
  return null;
}

export function getAntigravityCurrentModel() {
  const settings = readJson(ANTIGRAVITY_SETTINGS_PATH, null);
  return settings?.model || null;
}

export function getAntigravityModelAbbrev(label) {
  if (!label) return "??";
  const known = ANTIGRAVITY_MODEL_ABBREV[label];
  if (known) return known;
  const parens = label.match(/\(([^)]+)\)/);
  const head = label.match(/^(\w+)/);
  if (head && parens) {
    return `${head[1][0].toUpperCase()}${parens[1][0].toLowerCase()}`;
  }
  if (head) return head[1].slice(0, 2);
  return "??";
}
