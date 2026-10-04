/** latest-mac.yml as electron-builder writes it: the version, then each file's url, sha512 (base64) and size. */
export interface FeedFile {
  url: string
  sha512: string
  size: number
}

export interface Feed {
  version: string
  files: FeedFile[]
}

export function parseFeed(yaml: string): Feed | null {
  const text = yaml.replace(/\r\n/g, "\n")
  const version = /^version:\s*['"]?([^\s'"]+)/m.exec(text)?.[1]
  if (!version) return null
  const files: FeedFile[] = []
  for (const m of text.matchAll(/-\s+url:\s*['"]?([^\s'"]+)['"]?\s*\n\s+sha512:\s*(\S+)\s*\n\s+size:\s*(\d+)/g)) {
    files.push({ url: m[1], sha512: m[2], size: Number(m[3]) })
  }
  return { version, files }
}

/** True when `a` is a newer version than `b` ("1.2.0" > "1.1.9"; a pre-release is older than its release). */
export function isNewer(a: string, b: string): boolean {
  const split = (v: string) => {
    const [main, pre] = v.trim().replace(/^v/, "").split("-", 2)
    return { nums: main.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? "" }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return d > 0
  }
  if (x.pre === y.pre) return false
  if (!x.pre) return true
  if (!y.pre) return false
  return x.pre.localeCompare(y.pre, "en", { numeric: true }) > 0
}

/** The zip for this Mac: Apple Silicon (arm64) or Intel (x64). */
export function macZipFor(feed: Feed, arch: string): FeedFile | null {
  const suffix = arch === "arm64" ? "-arm64.zip" : "-x64.zip"
  return feed.files.find((f) => f.url.endsWith(suffix)) ?? null
}

/** A path as one single-quoted shell word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
