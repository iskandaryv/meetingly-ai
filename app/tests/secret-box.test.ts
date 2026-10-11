import { describe, expect, it, vi } from "vitest"
import { keychainBox, sealLegacyOwnKey, type KeychainStorage } from "../electron/services/secretBox"

function storage(overrides: Partial<KeychainStorage> = {}): KeychainStorage {
  return { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "gnome_libsecret", encryptString: value => Buffer.from(`sealed:${value}`), decryptString: value => value.toString().replace(/^sealed:/, ""), ...overrides }
}
describe("own-key storage boundary", () => {
  it("round-trips the existing enc format", () => {
    const box = keychainBox(storage())
    const encrypted = box.encrypt("fixture-key")
    expect(encrypted).toMatch(/^enc:/)
    expect(box.decrypt(encrypted)).toBe("fixture-key")
  })
  it("refuses unavailable storage rather than returning plaintext", () => {
    const box = keychainBox(storage({ isEncryptionAvailable: () => false }))
    expect(() => box.encrypt("fixture-key")).toThrow(/keychain/i)
    expect(() => box.decrypt("old-plaintext-key")).toThrow(/keychain/i)
  })
  it("rejects Linux basic_text even when Electron says encryption is available", () => {
    const box = keychainBox(storage({ getSelectedStorageBackend: () => "basic_text" }), "linux")
    expect(() => box.encrypt("fixture-key")).toThrow(/keychain/i)
  })
  it("reports a copied or damaged credential without sending an empty key", () => {
    const box = keychainBox(storage({ decryptString() { throw new Error("OS denied") } }))
    expect(() => box.decrypt("enc:YQ==")).toThrow(/Re-enter/)
  })
  it("migrates legacy plaintext and preserves the account configuration", () => {
    const own = { baseUrl: "https://provider.example/v1", model: "fixture-model", key: "legacy-fixture-key" }
    const update = vi.fn()
    expect(sealLegacyOwnKey({ get: () => ({ ownKey: own }), update }, keychainBox(storage()))).toBe(true)
    expect(update).toHaveBeenCalledWith({ ownKey: { ...own, key: expect.stringMatching(/^enc:/) } })
    expect(own.key).toBe("legacy-fixture-key")
  })
  it("does not erase a legacy key if the keychain is unavailable", () => {
    const update = vi.fn()
    expect(() => sealLegacyOwnKey({ get: () => ({ ownKey: { baseUrl: "https://provider.example/v1", model: "x", key: "legacy" } }), update }, keychainBox(storage({ isEncryptionAvailable: () => false })))).toThrow()
    expect(update).not.toHaveBeenCalled()
  })
  it("does not require a keychain for a key-free local model", () => {
    const update = vi.fn()
    expect(sealLegacyOwnKey({ get: () => ({ ownKey: { baseUrl: "http://localhost:11434/v1", model: "local", key: "" } }), update }, keychainBox(storage({ isEncryptionAvailable: () => false })))).toBe(false)
    expect(update).not.toHaveBeenCalled()
  })
})
