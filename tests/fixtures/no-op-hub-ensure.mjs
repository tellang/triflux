// Test fixture: no-op hub-ensure stub.
//
// Route integration tests exercise the full codex/agy/gemini exec path, which
// runs tfx-route.sh's unconditional hub-ensure (Issue #156). A real hub-ensure
// resolves the canonical default port (27888) and would spawn/bind a hub
// against the live developer hub while writing a pid into the test's temp HOME
// — polluting canonical hub state on every `npm test` run (v10.33.1 follow-up
// #1). Pointing TFX_HUB_ENSURE_SCRIPT at this file turns hub-ensure into a
// clean no-op so the tests verify routing without touching any hub. Mirrors the
// stub precedent in tests/unit/escalation-profile-route.test.mjs.
process.exit(0);
