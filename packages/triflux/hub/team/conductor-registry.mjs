function normalizeSessionId(sessionId) {
  if (sessionId == null) return "";
  return String(sessionId).trim();
}

export function createConductorRegistry() {
  const sessions = new Map();

  return Object.freeze({
    register(sessionId, conductor) {
      const normalizedSessionId = normalizeSessionId(sessionId);
      if (
        !normalizedSessionId ||
        !conductor ||
        typeof conductor.sendInput !== "function"
      ) {
        return false;
      }
      sessions.set(normalizedSessionId, conductor);
      return true;
    },

    unregister(sessionId, conductor = null) {
      const normalizedSessionId = normalizeSessionId(sessionId);
      if (!normalizedSessionId || !sessions.has(normalizedSessionId))
        return false;
      if (conductor && sessions.get(normalizedSessionId) !== conductor)
        return false;
      return sessions.delete(normalizedSessionId);
    },

    get(sessionId) {
      const normalizedSessionId = normalizeSessionId(sessionId);
      if (!normalizedSessionId) return null;
      return sessions.get(normalizedSessionId) || null;
    },

    clear() {
      sessions.clear();
    },

    list() {
      return [...sessions.keys()];
    },
  });
}

let conductorRegistry = null;

export function getConductorRegistry() {
  return conductorRegistry;
}

export function setConductorRegistry(nextRegistry) {
  const previousRegistry = conductorRegistry;
  conductorRegistry = nextRegistry ?? null;
  return previousRegistry;
}

export function ensureConductorRegistry() {
  if (!conductorRegistry) {
    conductorRegistry = createConductorRegistry();
  }
  return conductorRegistry;
}

export function sendInputToConductorSession(sessionId, text) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedText = typeof text === "string" ? text : "";

  if (!normalizedSessionId || !normalizedText) {
    return {
      ok: false,
      error: {
        code: "INVALID_SEND_INPUT",
        message: "session_id, text 필수",
      },
    };
  }

  const registry = getConductorRegistry();
  if (!registry) {
    return {
      ok: false,
      error: {
        code: "CONDUCTOR_REGISTRY_NOT_AVAILABLE",
        message: "Conductor registry가 초기화되지 않았습니다",
      },
    };
  }

  const conductor = registry.get(normalizedSessionId);
  if (!conductor) {
    return {
      ok: false,
      error: {
        code: "CONDUCTOR_SESSION_NOT_FOUND",
        message: `Conductor session not found: ${normalizedSessionId}`,
      },
    };
  }

  const sent = conductor.sendInput(normalizedSessionId, normalizedText);
  if (!sent) {
    return {
      ok: false,
      error: {
        code: "SEND_INPUT_FAILED",
        message: `입력 전송 실패: ${normalizedSessionId}`,
      },
    };
  }

  return {
    ok: true,
    data: {
      session_id: normalizedSessionId,
      sent: true,
    },
  };
}
