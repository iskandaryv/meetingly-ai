"""Translated READMEs: README.<lang>.md next to README.md, and the language row at the top of each.

  python docs/readme_i18n.py translate   where UPSTREAM_BASE_URL / UPSTREAM_API_KEY are set (the relay's env on the
                                         server): fills docs/readme-i18n/<lang>.json with any line not translated yet
  python docs/readme_i18n.py build       writes README.<lang>.md from README.md and those files

README.md is translated line by line, so only changed lines cost anything. Code blocks, images, badges and table
rulers stay as they are. A translation that changes a link, an image, an inline `code` span, the bold markers, the
HTML tags or a table's columns is dropped, and that line stays in English until the next run.
"""
import json
import os
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "docs", "readme-i18n")
LANGS = [
    ("zh-CN", "简体中文", "Simplified Chinese"),
    ("ru", "Русский", "Russian"),
    ("es", "Español", "Spanish"),
    ("pt-BR", "Português", "Brazilian Portuguese"),
    ("ja", "日本語", "Japanese"),
    ("ko", "한국어", "Korean"),
]
ROW = '<p align="center"><!-- languages -->'
KEEP_NAMES = (
    "Meetingly, Pro, Unlimited, GitHub, OpenAI, OpenRouter, Ollama, LM Studio, vLLM, LiteLLM, Cluely, Final Round AI, "
    "Parakeet AI, NVIDIA Nemotron, Electron, React, Vite, TypeScript, Tailwind, Node, Apache-2.0, AppImage, .deb, "
    "SmartScreen, Windows, macOS, Linux, Debian, Ubuntu, Intel, Apple Silicon, AI Prime Tech, Claude, GPT, SBP, Stripe"
)


def readme(name="README.md"):
    return open(os.path.join(ROOT, name), encoding="utf-8").read().split("\n")


def segments(lines):
    """(index, text) for every line that should be translated; everything else is copied as is."""
    out, fence = [], False
    for i, line in enumerate(lines):
        s = line.strip()
        if s.startswith("```"):
            fence = not fence
            continue
        if fence or not s or s.startswith(ROW) or re.fullmatch(r"\|?[\s:|-]+\|?", s):
            continue
        if s.startswith(("![", "<img", "<div", "</div", "&nbsp;", "<br")) or re.match(r'<a href="[^"]+"><img', s):
            continue
        if s == "# Meetingly":
            continue
        if not re.search(r"[A-Za-z]{2,}", re.sub(r"<[^>]+>|\]\([^)]*\)|`[^`]*`|https?://\S+", " ", s)):
            continue
        out.append((i, line))
    return out


def body(line):
    """The part of a line that is sent for translation: without a heading's #s or a list item's marker."""
    m = re.match(r"(\s*(?:#{1,6} |[-*] |\d+\. ))(.*)", line)
    return (m.group(1), m.group(2)) if m else ("", line)


def same_markup(src, tr):
    keys = [
        lambda s: sorted(re.findall(r"\]\(([^)]+)\)", s)),
        lambda s: sorted(re.findall(r'(?:href|src)="([^"]+)"', s)),
        lambda s: re.findall(r"`[^`]+`", s),
        lambda s: s.count("**"),
        lambda s: re.findall(r"</?([a-z]+)", s),
        lambda s: s.count("|") if s.lstrip().startswith("|") else 0,
    ]
    return all(k(src) == k(tr) for k in keys)


SYSTEM = """You translate lines of the README of Meetingly, an open-source desktop AI assistant for live meetings and interviews, into {name}.
Rules:
- Natural, clear {name} as used in good open-source READMEs. Keep it short; don't add anything.
- Keep Markdown and HTML exactly: every link target in (...), every href/src, every `inline code` span, the ** bold markers, the | table pipes, HTML tags and emoji.
- Keep these names as written: {keep}.
- Reply with one JSON object mapping every English line exactly as given to its translation. No comments."""


def ask(name, lines):
    base, key = os.environ["UPSTREAM_BASE_URL"].rstrip("/"), os.environ["UPSTREAM_API_KEY"]
    payload = {
        "model": os.environ.get("README_MODEL", "gpt-5.5"),
        "reasoning_effort": "low",
        "max_completion_tokens": 16000,
        "messages": [{"role": "system", "content": SYSTEM.format(name=name, keep=KEEP_NAMES)}, {"role": "user", "content": json.dumps(lines, ensure_ascii=False)}],
    }
    req = urllib.request.Request(base + "/chat/completions", data=json.dumps(payload).encode(), headers={"Authorization": "Bearer " + key, "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
    text = json.load(urllib.request.urlopen(req, timeout=300))["choices"][0]["message"]["content"]
    return json.loads(text[text.index("{"): text.rindex("}") + 1])


def translate():
    os.makedirs(CACHE, exist_ok=True)
    source = [body(line)[1] for _, line in segments(readme())]

    def one(lang):
        code, _, name = lang
        path = os.path.join(CACHE, f"{code}.json")
        done = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
        missing = [s for s in source if s not in done]
        dropped = 0
        for i in range(0, len(missing), 40):
            batch = missing[i : i + 40]
            got = {}
            for _ in range(2):
                try:
                    got = ask(name, batch)
                    break
                except Exception:
                    pass
            for s in batch:
                tr = got.get(s)
                if isinstance(tr, str) and tr.strip() and same_markup(s, tr):
                    done[s] = tr
                else:
                    dropped += 1
        kept = {s: done[s] for s in source if s in done}
        json.dump(dict(sorted(kept.items())), open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        return f"{code}: {len(kept)}/{len(source)} ({len(missing)} new, {dropped} left in English)"

    with ThreadPoolExecutor(6) as pool:
        for line in pool.map(one, LANGS):
            print(line, flush=True)


def language_row(current):
    links = ['<b>English</b>' if current == "en" else '<a href="README.md">English</a>']
    for code, native, _ in LANGS:
        links.append(f"<b>{native}</b>" if code == current else f'<a href="README.{code}.md">{native}</a>')
    return ROW + " · ".join(links) + "</p>"


def build():
    lines = readme()
    lines = [language_row("en") if l.strip().startswith(ROW) else l for l in lines]
    open(os.path.join(ROOT, "README.md"), "w", encoding="utf-8", newline="\n").write("\n".join(lines))
    todo = dict(segments(lines))
    for code, _, _ in LANGS:
        path = os.path.join(CACHE, f"{code}.json")
        tr = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
        out = []
        for i, line in enumerate(lines):
            if line.strip().startswith(ROW):
                out.append(language_row(code))
            elif i in todo:
                prefix, text = body(line)
                out.append(prefix + tr.get(text, text))
            else:
                out.append(line)
        open(os.path.join(ROOT, f"README.{code}.md"), "w", encoding="utf-8", newline="\n").write("\n".join(out))
        print(f"README.{code}.md: {sum(1 for i in todo if body(lines[i])[1] in tr)}/{len(todo)} lines translated")


if __name__ == "__main__":
    {"translate": translate, "build": build}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: print(__doc__))()
