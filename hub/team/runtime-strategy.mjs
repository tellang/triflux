// hub/team/runtime-strategy.mjs — Strategy pattern for team runtime backends

/**
 * Abstract base class for team runtime implementations.
 * Concrete subclasses handle psmux, native, or wt execution environments.
 */
export class TeamRuntime {
  get name() { throw new Error('not implemented'); }
  async start(config) { throw new Error('not implemented'); }
  async stop(state) { throw new Error('not implemented'); }
  async isAlive(state) { throw new Error('not implemented'); }
  async focus(member) { throw new Error('not implemented'); }
  async sendKeys(member, text) { throw new Error('not implemented'); }
  async interrupt(member) { throw new Error('not implemented'); }
  async getStatus() { throw new Error('not implemented'); }
}

export class PsmuxRuntime extends TeamRuntime {
  get name() { return 'psmux'; }

  async start(config) {
    console.log('[PsmuxRuntime] start called');
    return {};
  }

  async stop(state) {
    console.log('[PsmuxRuntime] stop called');
    return {};
  }

  async isAlive(state) {
    console.log('[PsmuxRuntime] isAlive called');
    return false;
  }

  async focus(member) {
    console.log('[PsmuxRuntime] focus called');
    return {};
  }

  async sendKeys(member, text) {
    console.log('[PsmuxRuntime] sendKeys called');
    return {};
  }

  async interrupt(member) {
    console.log('[PsmuxRuntime] interrupt called');
    return {};
  }

  async getStatus() {
    console.log('[PsmuxRuntime] getStatus called');
    return {};
  }
}

export class NativeRuntime extends TeamRuntime {
  get name() { return 'native'; }

  async start(config) {
    console.log('[NativeRuntime] start called');
    return {};
  }

  async stop(state) {
    console.log('[NativeRuntime] stop called');
    return {};
  }

  async isAlive(state) {
    console.log('[NativeRuntime] isAlive called');
    return false;
  }

  async focus(member) {
    console.log('[NativeRuntime] focus called');
    return {};
  }

  async sendKeys(member, text) {
    console.log('[NativeRuntime] sendKeys called');
    return {};
  }

  async interrupt(member) {
    console.log('[NativeRuntime] interrupt called');
    return {};
  }

  async getStatus() {
    console.log('[NativeRuntime] getStatus called');
    return {};
  }
}

export class WtRuntime extends TeamRuntime {
  get name() { return 'wt'; }

  async start(config) {
    console.log('[WtRuntime] start called');
    return {};
  }

  async stop(state) {
    console.log('[WtRuntime] stop called');
    return {};
  }

  async isAlive(state) {
    console.log('[WtRuntime] isAlive called');
    return false;
  }

  async focus(member) {
    console.log('[WtRuntime] focus called');
    return {};
  }

  async sendKeys(member, text) {
    console.log('[WtRuntime] sendKeys called');
    return {};
  }

  async interrupt(member) {
    console.log('[WtRuntime] interrupt called');
    return {};
  }

  async getStatus() {
    console.log('[WtRuntime] getStatus called');
    return {};
  }
}

/**
 * Factory function that returns a TeamRuntime instance for the given mode.
 * @param {'psmux'|'native'|'wt'} mode
 * @returns {TeamRuntime}
 */
export function createRuntime(mode) {
  switch (mode) {
    case 'psmux': return new PsmuxRuntime();
    case 'native': return new NativeRuntime();
    case 'wt': return new WtRuntime();
    default: throw new Error(`Unknown runtime mode: ${mode}`);
  }
}
