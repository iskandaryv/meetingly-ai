/**
 * Where the desktop app sends its requests. The relay holds the real provider
 * keys; the app only carries this URL and a shared app token.
 *
 * Override for development with IGPT_RELAY_URL (e.g. http://127.0.0.1:8090).
 * The token is not a secret in the cryptographic sense (it ships inside the
 * app); it exists so random internet traffic cannot use the relay, and so it
 * can be rotated together with a new build if abused.
 */
export const RELAY_URL = "https://aiprimetech.io/igpt"
export const APP_TOKEN = "igpt_v1_7Qm3xLk9pZ2vT8nR4wYb6Hd1Fs5Ja0Ce"

export function relayHttpUrl(base?: string): string {
  return (base || RELAY_URL).replace(/\/+$/, "")
}

export function relayWsUrl(base?: string): string {
  return relayHttpUrl(base).replace(/^http/, "ws")
}
