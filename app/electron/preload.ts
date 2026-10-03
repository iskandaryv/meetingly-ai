import { contextBridge, ipcRenderer } from "electron"
import { EVENT_CHANNELS, INVOKE_CHANNELS, type RendererApi } from "../shared/ipc"

const invokeSet = new Set<string>(INVOKE_CHANNELS)
const eventSet = new Set<string>(EVENT_CHANNELS)

const api: RendererApi = {
  invoke: (channel, ...args) => {
    if (!invokeSet.has(channel)) return Promise.reject(new Error(`Unknown IPC channel: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel, listener) => {
    if (!eventSet.has(channel)) throw new Error(`Unknown IPC event: ${channel}`)
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld("api", api)
