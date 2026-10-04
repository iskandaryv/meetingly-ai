"""Translate interface strings into every language Meetingly speaks, filling only what is missing.

  python3 i18n_translate.py <en.json> <languages.json> <out_dir> [model]

en.json is the English source list (scripts/i18n.mjs extract); languages.json is [{code, name}];
out_dir gets <code>.json files mapping English -> translation. Runs where the AI gateway key is
(UPSTREAM_BASE_URL / UPSTREAM_API_KEY in the environment, e.g. the relay's env file on Voyra).
A translation that loses or adds a {placeholder} or changes the HTML tags is dropped, so that string stays in English.
"""
import json, os, re, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE, KEY = os.environ["UPSTREAM_BASE_URL"], os.environ["UPSTREAM_API_KEY"]
en_file, langs_file, out_dir = sys.argv[1:4]
MODEL = sys.argv[4] if len(sys.argv) > 4 else "gpt-5.5"
BATCH = 60

SYSTEM = """You translate the interface of Meetingly, a desktop AI assistant for live meetings and job interviews, into {name}.
Rules:
- Translate each English string as it would appear in polished {name} software: short, natural, the usual tone of that language's apps.
- Keep every {{placeholder}} exactly as written (same name, same braces), and keep "Meetingly", "Pro", "Stripe", "Enot", "SBP", "UTC", "API", "OpenAI", "OpenRouter", "Ollama", keyboard keys (Ctrl, Alt, Shift, Enter, Esc) and emoji unchanged.
- Keep punctuation style: an ellipsis (…) stays an ellipsis, a trailing period stays.
- Some strings contain HTML: keep every tag and attribute exactly as written and in the same order; translate only the text between tags.
- Reply with one JSON object mapping every English string exactly as given to its translation. No comments."""


def ask(name, strings):
    body = {"model": MODEL, "reasoning_effort": "low", "max_completion_tokens": 16000,
            "messages": [{"role": "system", "content": SYSTEM.format(name=name)},
                         {"role": "user", "content": json.dumps(strings, ensure_ascii=False)}]}
    req = urllib.request.Request(BASE + "/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
    text = json.load(urllib.request.urlopen(req, timeout=300))["choices"][0]["message"]["content"]
    return json.loads(text[text.index("{"): text.rindex("}") + 1])


def placeholders(s):
    return sorted(re.findall(r"\{\w+\}", s))


def tags(s):
    return re.findall(r"<[^>]+>", s)


def translate(lang):
    code, name = lang["code"], lang["name"]
    path = os.path.join(out_dir, f"{code}.json")
    done = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    source = json.load(open(en_file, encoding="utf-8"))
    missing = [s for s in source if s not in done]
    dropped = 0
    for i in range(0, len(missing), BATCH):
        batch = missing[i:i + BATCH]
        for attempt in range(2):
            try:
                got = ask(name, batch)
                break
            except Exception as e:
                got = {}
                err = e
        for s in batch:
            tr = got.get(s)
            if isinstance(tr, str) and tr.strip() and placeholders(tr) == placeholders(s) and tags(tr) == tags(s):
                done[s] = tr
            else:
                dropped += 1
    # Only strings still in the source list are kept.
    kept = {s: done[s] for s in source if s in done}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(dict(sorted(kept.items())), f, ensure_ascii=False, indent=1)
        f.write("\n")
    return f"{code}: {len(kept)}/{len(source)} ({len(missing)} new, {dropped} left in English)"


langs = [l for l in json.load(open(langs_file, encoding="utf-8")) if l["code"] != "en"]
os.makedirs(out_dir, exist_ok=True)
with ThreadPoolExecutor(6) as pool:
    for line in pool.map(translate, langs):
        print(line, flush=True)
