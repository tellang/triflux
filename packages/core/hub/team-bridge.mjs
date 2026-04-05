// @triflux/core — team-bridge 인터페이스
// remote 패키지가 런타임에 구현을 주입한다.

/**
 * @typedef {object} TeamBridge
 * @property {(args?: object) => Promise<object>} teamInfo
 * @property {(args?: object) => Promise<object>} teamTaskList
 * @property {(args?: object) => Promise<object>} teamTaskUpdate
 * @property {(args?: object) => Promise<object>} teamSendMessage
 */

/** @type {TeamBridge | null} */
let _bridge = null;

/**
 * @param {TeamBridge | null} impl
 */
export function registerTeamBridge(impl) {
  _bridge = impl;
}

/**
 * @returns {TeamBridge | null}
 */
export function getTeamBridge() {
  return _bridge;
}
