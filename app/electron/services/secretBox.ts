import type { SecretBox } from "./ownKey"
import { t } from "../../shared/i18n"

export interface KeychainStorage {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** Never save credentials using Electron's unprotected Linux/basic_text fallback. */
export function keychainBox(storage: KeychainStorage, platform: string = process.platform): SecretBox {
  const requireKeychain = () => {
    if (!storage.isEncryptionAvailable() || (platform === "linux" && storage.getSelectedStorageBackend?.() === "basic_text")) {
      throw new Error(t("Secure key storage is unavailable. Enable your operating system's keychain before saving or using an API key. Key-free local models still work."))
    }
  }
  return {
    encrypt(plain) {
      requireKeychain()
      return `enc:${storage.encryptString(plain).toString("base64")}`
    },
    decrypt(stored) {
      requireKeychain()
      // Older builds saved unencrypted values. The startup migration seals them
      // without deleting the original setting if the OS keychain is unavailable.
      if (!stored.startsWith("enc:")) return stored
      try {
        return storage.decryptString(Buffer.from(stored.slice(4), "base64"))
      } catch {
        throw new Error(t("The saved API key cannot be opened on this computer. Re-enter it in Use your own API key."))
      }
    }
  }
}

export function sealLegacyOwnKey(
  settings: { get(): { ownKey: { baseUrl: string; model: string; key: string } | null }; update(patch: { ownKey: { baseUrl: string; model: string; key: string } }): unknown },
  box: SecretBox
): boolean {
  const own = settings.get().ownKey
  if (!own?.key || own.key.startsWith("enc:")) return false
  const key = box.encrypt(own.key)
  settings.update({ ownKey: { ...own, key } })
  return true
}
