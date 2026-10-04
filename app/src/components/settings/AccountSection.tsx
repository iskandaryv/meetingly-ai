import { useState } from "react"
import { Cloud, CloudOff, ExternalLink, Link2, Link2Off, RefreshCw, Sparkles } from "lucide-react"
import { t } from "@shared/i18n"
import { api } from "@/lib/api"
import { useCloudState, usePlanState } from "@/lib/hooks"
import { formatWhen } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

/** Link this install to an account; settings, prompts and meetings then follow the account. */
export function AccountSection() {
  const cloud = useCloudState()
  const plan = usePlanState()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const status =
    cloud.status === "online" ? (
      <Badge variant="success"><Cloud className="h-3 w-3" /> {t("Synced")}</Badge>
    ) : cloud.status === "offline" ? (
      <Badge variant="warning"><CloudOff className="h-3 w-3" /> {t("Offline")}</Badge>
    ) : cloud.status === "linking" ? (
      <Badge variant="info">{t("Waiting for the browser…")}</Badge>
    ) : cloud.status === "error" ? (
      <Badge variant="danger">{t("Error")}</Badge>
    ) : (
      <Badge>{t("Not connected")}</Badge>
    )

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-white">{t("Account")} {status}</div>
          <p className="mt-0.5 text-xs text-white/55">
            {cloud.email
              ? t("Connected as {email}. Settings, prompts and meetings sync with your account and any other computer you connect.", { email: cloud.email })
              : t("Connect an account to edit settings and prompts in the browser and keep meetings across computers.")}
          </p>
        </div>
      </div>

      {plan.status === "ok" && plan.used && plan.limits && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-white/10 bg-black/20 px-3 py-2">
          <div className="text-xs text-white/70">
            <span className="font-medium text-white">{plan.plan === "pro" ? t("Pro") : t("Free plan")}</span>
            {" · "}
            {plan.plan === "pro"
              ? t("unlimited answers")
              : t("{left} of {total} answers left today", { left: Math.max(0, plan.limits.answers - plan.used.answers), total: plan.limits.answers })}
          </div>
          <Button variant={plan.plan === "pro" ? "ghost" : "primary"} size="sm" onClick={() => run(() => api.invoke("plan:upgrade"))}>
            <Sparkles className="h-3.5 w-3.5" /> {plan.plan === "pro" ? t("Manage plan") : t("Upgrade to Pro")}
          </Button>
        </div>
      )}

      {cloud.status === "linking" && (
        <div className="mb-3 rounded-md border border-sky-400/30 bg-sky-500/10 p-3 text-center">
          <p className="text-xs text-sky-100">{t("Your browser opened the sign-in page. Make sure it shows this code, then confirm there:")}</p>
          <p className="my-1.5 font-mono text-2xl tracking-[0.3em] text-white">{cloud.code}</p>
          <div className="flex justify-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => cloud.linkUrl && api.invoke("cloud:open-web")}>
              <ExternalLink className="h-3.5 w-3.5" /> {t("Open the page again")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => run(() => api.invoke("cloud:link-cancel"))}>
              {t("Cancel")}
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {cloud.status === "off" || cloud.status === "linking" ? (
          <Button variant="primary" size="sm" disabled={busy || cloud.status === "linking"} onClick={() => run(() => api.invoke("cloud:link-start"))}>
            <Link2 className="h-3.5 w-3.5" /> {t("Connect account")}
          </Button>
        ) : (
          <>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => run(() => api.invoke("cloud:open-web"))}>
              <ExternalLink className="h-3.5 w-3.5" /> {t("Open web dashboard")}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(() => api.invoke("cloud:sync-now"))}>
              <RefreshCw className="h-3.5 w-3.5" /> {t("Sync now")}
            </Button>
            <Button variant="ghost" size="sm" className="text-rose-300/80 hover:text-rose-300" disabled={busy} onClick={() => run(() => api.invoke("cloud:unlink"))}>
              <Link2Off className="h-3.5 w-3.5" /> {t("Disconnect")}
            </Button>
          </>
        )}
        {cloud.lastSync && <span className="text-[11px] text-white/40">{t("last sync {when}", { when: formatWhen(cloud.lastSync) })}</span>}
      </div>
      {(error || cloud.error) && <p className="mt-2 text-xs text-amber-200">{error ?? cloud.error}</p>}
    </div>
  )
}
