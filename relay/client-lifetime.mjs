/** Cancel provider work when the response connection disappears, including before headers arrive. */
export function clientLifetime(response) {
  const controller = new AbortController()
  const close = () => { if (!response.writableFinished) controller.abort(new Error("Client disconnected")) }
  response.once("close", close)
  if (response.destroyed) close()
  return { signal: controller.signal, dispose: () => response.off("close", close) }
}
