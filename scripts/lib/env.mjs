export function buildPreflightEnv(env = process.env) {
  return {
    ...env,
    GIT_TERMINAL_PROMPT: env.GIT_TERMINAL_PROMPT ?? "0",
    GIT_ASKPASS: env.GIT_ASKPASS ?? "false",
    npm_config_yes: env.npm_config_yes ?? "true",
  };
}

export function shouldWarnGhAuth(env = process.env, checks = {}) {
  if (!checks.ghExists) return false;
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return false;
  return checks.ghAuthenticated === false;
}
