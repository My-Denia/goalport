// The renderer publishes connection state on the shell even when the status
// pill is hidden at narrow widths. Conversation text is not connection state.
export function uiConnectionState({ shellConnection }) {
  return shellConnection === "connected";
}

export function connectedUiExpression() {
  return `Boolean((${uiConnectionState.toString()})({ shellConnection: document.querySelector('.goalport-shell')?.dataset?.connection ?? null }))`;
}
