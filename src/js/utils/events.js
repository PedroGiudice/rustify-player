const { invoke } = window.__TAURI__.core;

export const SESSION_ID = crypto.randomUUID();

export function logEvent(eventType, data = {}) {
  invoke("log_event", {
    payload: {
      event_type: eventType,
      timestamp: Math.floor(Date.now() / 1000),
      session_id: SESSION_ID,
      ...data,
    },
  }).catch((err) => console.warn("[events]", eventType, err));
}
