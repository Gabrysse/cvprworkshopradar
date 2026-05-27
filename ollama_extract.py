#!/usr/bin/env python3
"""
CVPR 2026 — Ollama-based program extractor.

For each event that has a website:
  1. Renders the page with Playwright (full JS execution)
  2. Extracts plain text from the rendered HTML (+ probes schedule subpages)
  3. Asks a local Ollama model to extract the schedule / program
  4. Writes program_text, program_found back to the JSON

Usage:
    python3 ollama_extract.py                          # text + vision fallback, skip already-found
    python3 ollama_extract.py --debug                  # dry-run: write to debug_extract.json, print diff
    python3 ollama_extract.py --debug --force          # debug all entries (including already-found)
    python3 ollama_extract.py --compare                # re-print comparison from last debug run
    python3 ollama_extract.py --force                  # re-extract everything
    python3 ollama_extract.py --only-failed            # retry program_found=False entries
    python3 ollama_extract.py --no-fallback            # text only, skip vision fallback
    python3 ollama_extract.py --vision                 # vision only (no text pass)
    python3 ollama_extract.py --model qwen3.5:0.8b     # override text model
    python3 ollama_extract.py --vision-model qwen3-vl:8b  # override vision model
    python3 ollama_extract.py --max 5                  # limit to N entries (testing)
    python3 ollama_extract.py --url https://...        # single URL (ad-hoc testing)

Ollama must be running: `ollama serve`
"""

import argparse
import base64
import csv as _csv_mod
import io
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from PIL import Image

JSON_PATH = Path(__file__).parent / "cvpr2026_workshops_tutorials.json"
DEBUG_PATH = Path(__file__).parent / "debug_extract.json"
OLLAMA_URL = "http://localhost:11434/api/generate"

DEFAULT_TEXT_MODEL = "qwen3.5:9b"
DEFAULT_VISION_MODEL = "qwen3.5:9b"

# How much page text to send to the LLM (characters)
MAX_CONTEXT_CHARS = 10_000
# Cap on stored program_text
MAX_PROGRAM_CHARS = 4_000
# Vision image collection
_MIN_IMAGE_BYTES = 15_000  # skip tiny icons / spacers
_MAX_INLINE_IMAGES = 3  # cap to avoid overwhelming the VLM
_VLM_MAX_DIM = 1024  # resize images to this max dimension before sending

# ─── Prompts ──────────────────────────────────────────────────────────────────

_TEXT_PROMPT = """\
Extract the workshop schedule or program from the page content below.

A schedule exists if the page lists talks, sessions, or events for the workshop —
times are NOT required (a program outline without specific times still counts).

Output format — ALWAYS use a Markdown table:
| Time | Title | Session | Speaker |
|------|-------|---------|----------|
| 9:00 AM | Advances in 3D Reconstruction | Keynote | Jane Doe |

Column rules:
- **Time**: the listed time slot, or "-" if not given.
- **Title**: the explicit talk/paper title. If no title is given but an abstract \
or description is present, write a concise (≤8 word) summary as the title. \
Use "-" only if there is truly no title and no description to summarise.
- **Session**: the session type (e.g. Keynote, Invited Talk, Oral, Poster, \
Break, Opening Remarks). Use "-" if not categorised.
- **Speaker**: the speaker name(s), or "-" if not listed.
- Use "TBD" only when the page explicitly says TBA/TBD for that field.
- If the page lists a date, room, or full-day time range, add it as a single \
bold line **before** the table (e.g. **June 3, 2026 | 8:00 AM – 1:00 PM | Room 103**).
- If there is NO schedule at all (only call for papers, organizer bios, \
submission deadlines, challenge rules, topic lists, etc.), output exactly: NO_SCHEDULE
- Do NOT add any introductory or closing prose. Output only the table (and \
optional header line) or NO_SCHEDULE.

Page content:
{text}

Schedule:"""

_VISION_PROMPT = """\
Extract the workshop schedule or program from this image of a conference \
workshop website.

A schedule exists if the image shows talks, sessions, or events for the workshop —
times are NOT required.

Output format — ALWAYS use a Markdown table:
| Time | Title | Session | Speaker |
|------|-------|---------|----------|

Column rules:
- **Time**: the listed time slot, or "-" if not visible.
- **Title**: the explicit talk/paper title. If no title but an abstract or \
description is visible, write a concise (≤8 word) summary as the title. \
Use "-" only if there is truly nothing to summarise.
- **Session**: the session type (Keynote, Invited Talk, Oral, Poster, Break, etc.).
- **Speaker**: speaker name(s), or "-" if not listed.
- Use "TBD" only when the image explicitly says TBA/TBD.
- Add date/room as a bold line **before** the table if visible.
- If there is NO schedule visible, output exactly: NO_SCHEDULE
- Do NOT add any introductory or closing text.

Schedule:"""


# ─── Playwright helpers ───────────────────────────────────────────────────────

# Link text / URL path keywords that suggest a schedule subpage
_SCHEDULE_LINK_KW = {
    "schedule",
    "program",
    "programme",
    "agenda",
    "timetable",
    "sessions",
    "talks",
}


def _resize_for_vlm(data: bytes) -> bytes | None:
    """Resize image bytes to at most _VLM_MAX_DIM on the longest side,
    returning JPEG bytes.  Returns None if the data cannot be opened."""
    try:
        img = Image.open(io.BytesIO(data)).convert("RGB")
        w, h = img.size
        max_dim = max(w, h)
        if max_dim > _VLM_MAX_DIM:
            scale = _VLM_MAX_DIM / max_dim
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85, optimize=True)
        return buf.getvalue()
    except Exception:
        return None


def _schedule_subpages(soup: BeautifulSoup, current_url: str) -> list[str]:
    """Return same-domain links whose text or path matches schedule keywords."""
    from urllib.parse import urljoin, urlparse

    base_netloc = urlparse(current_url).netloc
    seen: set[str] = set()
    result: list[str] = []

    for a in soup.find_all("a", href=True):
        href = (a["href"] or "").strip()
        if not href or href.startswith(("#", "mailto:", "javascript:")):
            continue
        full = urljoin(current_url, href).split("#")[0]
        parsed = urlparse(full)
        if parsed.netloc != base_netloc:
            continue
        if full.rstrip("/") == current_url.rstrip("/"):
            continue
        link_text = a.get_text(strip=True).lower()
        path_lower = parsed.path.lower()
        if any(kw in link_text or kw in path_lower for kw in _SCHEDULE_LINK_KW):
            if full not in seen:
                seen.add(full)
                result.append(full)

    return result


def _get_page_text(url: str, timeout_s: int = 30) -> tuple[str, str, list[str]]:
    """Render *url* with Playwright; return (final_url, plain_text, subpage_candidates).

    In addition to the main page HTML, collects:
    - Google Sheets embeds: fetched as CSV and appended as tab-separated text.
    - about:blank frames with content: used by Google Docs embeds injected via
      Google Sites' gapi.rpc mechanism.
    """
    from playwright.sync_api import sync_playwright

    extra_texts: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        try:
            try:
                page.goto(url, wait_until="networkidle", timeout=timeout_s * 1000)
            except Exception:
                # Page has perpetual background requests (e.g. Northeastern sites);
                # use whatever is loaded and give JS a moment to settle.
                try:
                    page.wait_for_timeout(3000)
                except Exception:
                    pass
            final_url = page.url
            html = page.content()

            # If the page rendered very little visible content, JS may still be
            # running (common with Squarespace/SPA sites that post-render content
            # after networkidle fires).  Wait and re-fetch once.
            try:
                visible_len = page.evaluate(
                    "() => (document.body?.innerText || '').trim().length"
                )
                if visible_len < 500:
                    page.wait_for_timeout(4_000)
                    html = page.content()
                    final_url = page.url
            except Exception:
                pass

            # --- Google Sheets iframes: convert to CSV text ---
            for frame in page.frames:
                if "spreadsheets" not in frame.url or "pub" not in frame.url:
                    continue
                m = re.match(
                    r"(https://docs\.google\.com/spreadsheets/d/e/[^/?#]+)/pub",
                    frame.url,
                )
                if not m:
                    continue
                csv_url = m.group(1) + "/pub?output=csv&gid=0"
                try:
                    r = requests.get(
                        csv_url,
                        timeout=10,
                        headers={"User-Agent": "Mozilla/5.0"},
                        allow_redirects=True,
                    )
                    if r.ok and r.text:
                        rows = list(_csv_mod.reader(io.StringIO(r.text)))
                        lines = [
                            "\t".join(c.strip() for c in row if c.strip())
                            for row in rows
                            if any(c.strip() for c in row)
                        ]
                        if lines:
                            extra_texts.append(
                                "[Embedded schedule]\n" + "\n".join(lines)
                            )
                except Exception:
                    pass

            # --- about:blank frames: Google Docs injected via document.write ---
            # Google Sites uses gapi.rpc to write doc HTML into an about:blank
            # sub-frame of the googleusercontent.com wrapper iframe.
            seen_blank: set[str] = set()
            for frame in page.frames:
                if frame.url != "about:blank":
                    continue
                try:
                    txt = frame.evaluate('() => document.body?.innerText || ""')
                    txt = txt.strip()
                    if len(txt) > 100 and txt not in seen_blank:
                        seen_blank.add(txt)
                        extra_texts.append("[Embedded document]\n" + txt)
                except Exception:
                    pass

        finally:
            browser.close()

    soup = BeautifulSoup(html, "lxml")

    # Collect schedule-subpage candidates before stripping navigation
    subpages = _schedule_subpages(soup, final_url)

    # Remove noise tags.
    # Note: <nav> and <footer> are stripped only when short (pure navigation /
    # copyright footers).  Some SPA frameworks (e.g. Squarespace) place actual
    # page-content sections inside a large <footer id="footer-sections"> element,
    # so we keep those to avoid discarding schedule text.
    for tag in soup(["script", "style", "noscript", "meta", "head", "aside"]):
        tag.decompose()
    for nav in soup.find_all("nav"):
        if len(nav.get_text(strip=True)) < 300:
            nav.decompose()
    for footer in soup.find_all("footer"):
        if len(footer.get_text(strip=True)) < 300:
            footer.decompose()

    body = soup.body or soup
    text = body.get_text(separator="\n", strip=True)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]{2,}", " ", text)

    if extra_texts:
        text = "\n\n".join(extra_texts) + "\n\n" + text.strip()

    return final_url, text.strip(), subpages


def _get_page_images(url: str, timeout_s: int = 30) -> tuple[str, list[bytes]]:
    """Return (final_url, images) — images from the page that are large enough
    to plausibly contain a schedule.

    Collects both <img> src/data-src attributes AND CSS background-image URLs.
    Scrolls the page before collecting so lazy-loaded content is triggered.
    Filters by file size (≥ _MIN_IMAGE_BYTES) to skip icons and logos.
    No full-page screenshot is taken.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        try:
            try:
                page.goto(url, wait_until="networkidle", timeout=timeout_s * 1000)
            except Exception:
                try:
                    page.wait_for_timeout(3000)
                except Exception:
                    pass
            final_url = page.url
            # Scroll to bottom to trigger lazy-loaded images, then back to top
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(1000)
            page.evaluate("window.scrollTo(0, 0)")

            img_srcs: list[str] = page.evaluate("""
                () => {
                    const srcs = new Set();
                    const imgExts = /\\.(png|jpe?g|gif|webp|bmp|svg)(\\?.*)?$/i;
                    const abs = (s) => { try { return new URL(s, location.href).href; } catch { return ''; } };

                    // <img> src and common lazy-load attributes
                    for (const img of document.querySelectorAll('img')) {
                        for (const attr of ['src', 'data-src', 'data-lazy-src',
                                            'data-original', 'data-lazy']) {
                            const s = abs(img.getAttribute(attr) || '');
                            if (s) srcs.add(s);
                        }
                    }
                    // <embed src> and <object data> — often used for schedule images/PDFs
                    for (const el of document.querySelectorAll('embed[src], object[data]')) {
                        const s = abs(el.getAttribute('src') || el.getAttribute('data') || '');
                        if (s && imgExts.test(s)) srcs.add(s);
                    }
                    // <a href> pointing directly to an image file
                    for (const a of document.querySelectorAll('a[href]')) {
                        const s = abs(a.getAttribute('href') || '');
                        if (s && imgExts.test(s)) srcs.add(s);
                    }
                    // Broad sweep: any src/href attribute on any element ending in image ext
                    for (const el of document.querySelectorAll('[src],[href]')) {
                        for (const attr of ['src', 'href']) {
                            const s = abs(el.getAttribute(attr) || '');
                            if (s && imgExts.test(s)) srcs.add(s);
                        }
                    }
                    // CSS background-image on any element
                    for (const el of document.querySelectorAll('*')) {
                        const bg = getComputedStyle(el).backgroundImage;
                        const m = bg && bg.match(/url\\(["']?(https?:[^"')]+)["']?\\)/);
                        if (m) srcs.add(m[1]);
                    }
                    return [...srcs].filter(s => s.startsWith('http'));
                }
            """)
        finally:
            browser.close()

    # Prioritise URLs whose path contains a schedule-related keyword so that
    # a cap further down doesn't accidentally drop the most relevant image.
    _sched_kw = {"agenda", "schedule", "program", "programme", "timetable"}
    priority, rest = [], []
    for s in img_srcs:
        path = s.lower()
        (priority if any(k in path for k in _sched_kw) else rest).append(s)
    ordered_srcs = priority + rest

    images: list[bytes] = []
    for src in ordered_srcs:
        if len(images) >= _MAX_INLINE_IMAGES:
            break
        try:
            if src.startswith("data:"):
                _, payload = src.split(",", 1)
                data = base64.b64decode(payload)
            else:
                r = requests.get(
                    src,
                    timeout=10,
                    headers={"User-Agent": "Mozilla/5.0"},
                    allow_redirects=True,
                )
                if not r.ok:
                    continue
                data = r.content
            if len(data) >= _MIN_IMAGE_BYTES:
                resized = _resize_for_vlm(data)
                if resized is not None:
                    images.append(resized)
        except Exception:
            pass

    return final_url, images


# ─── Ollama helper ────────────────────────────────────────────────────────────


def _call_ollama(model: str, prompt: str, images: list[str] | None = None) -> str:
    payload: dict = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "think": False,
        "options": {
            "temperature": 0,
            "num_predict": 1024,
        },
    }
    if images:
        payload["images"] = images

    resp = requests.post(OLLAMA_URL, json=payload, timeout=180)
    resp.raise_for_status()
    return resp.json().get("response", "").strip()


def _check_ollama(model: str) -> None:
    """Raise SystemExit if Ollama is unreachable or model is missing."""
    try:
        r = requests.get("http://localhost:11434/api/tags", timeout=5)
        r.raise_for_status()
        names = [m["name"] for m in r.json().get("models", [])]
    except Exception as e:
        sys.exit(f"Cannot reach Ollama at localhost:11434 — {e}\nRun: ollama serve")
    if model not in names:
        sys.exit(
            f"Model '{model}' not found in Ollama.\n"
            f"Available: {', '.join(names)}\n"
            f"Pull it with: ollama pull {model}"
        )


# ─── Comparison helper ────────────────────────────────────────────────────────


def _print_comparison(debug_path: Path) -> None:
    """Pretty-print a diff between old (JSON) and new (debug file) extractions."""
    if not debug_path.exists():
        print(f"Debug file not found: {debug_path}")
        return

    rec = json.loads(debug_path.read_text())
    results = rec.get("results", [])
    print(f"\nDebug run : {rec.get('run_at', '?')}")
    print(f"Model     : {rec.get('model', '?')}  |  mode: {rec.get('mode', '?')}")
    print(f"Entries   : {len(results)}\n")

    improved, regressed, both_found, both_missing = [], [], [], []
    for r in results:
        old, new = r["old_found"], r["new_found"]
        if old and new:
            both_found.append(r)
        elif not old and new:
            improved.append(r)
        elif old and not new:
            regressed.append(r)
        else:
            both_missing.append(r)

    SEP = "─" * 72

    if improved:
        print(f"{'─' * 25}  IMPROVEMENTS ({len(improved)})  {'─' * 25}")
        for r in improved:
            print(f"  + {r['title'][:60]}")
            print(f"    {r['website']}")
            snippet = (r.get("new_text") or "")[:120].replace("\n", " │ ")
            print(f"    NEW ▶ {snippet}")
            print()

    if regressed:
        print(f"{'─' * 26}  REGRESSIONS ({len(regressed)})  {'─' * 26}")
        for r in regressed:
            print(f"  - {r['title'][:60]}")
            print(f"    {r['website']}")
            snippet = (r.get("old_text") or "")[:120].replace("\n", " │ ")
            print(f"    OLD ▶ {snippet}")
            print()

    if both_found:
        print(f"{'─' * 23}  BOTH FOUND — TEXT DIFF ({len(both_found)})  {'─' * 23}")
        for r in both_found:
            old_t = (r.get("old_text") or "").strip()
            new_t = (r.get("new_text") or "").strip()
            # Simple similarity: word-overlap ratio
            old_words = set(old_t.lower().split())
            new_words = set(new_t.lower().split())
            union = old_words | new_words
            overlap = len(old_words & new_words) / len(union) if union else 1.0
            tag = "≈same" if overlap >= 0.6 else "DIFFERS"
            print(f"  [{tag}] {r['title'][:55]}  (overlap={overlap:.0%})")
            if overlap < 0.6:
                print(f"    OLD ▶ {old_t[:120].replace(chr(10), ' │ ')}")
                print(f"    NEW ▶ {new_t[:120].replace(chr(10), ' │ ')}")
        print()

    print(SEP)
    print(f"  Improvements (new found)   : {len(improved):3d}")
    print(f"  Regressions  (new missed)  : {len(regressed):3d}")
    print(f"  Both found                 : {len(both_found):3d}")
    print(f"  Both not found             : {len(both_missing):3d}")
    print(SEP)


# ─── Per-event extraction ─────────────────────────────────────────────────────


def _extract(
    ev: dict,
    text_model: str,
    vision_model: str,
    *,
    vision_only: bool = False,
    no_fallback: bool = False,
) -> dict:
    """Try text extraction first; fall back to vision if nothing found."""
    url = ev["website"]

    def _is_empty(response: str) -> bool:
        cleaned = re.sub(r"<think>.*?</think>", "", response, flags=re.DOTALL).strip()
        return not cleaned or cleaned.upper().startswith("NO_SCHEDULE")

    def _text_pass(target_url: str) -> tuple[str, str, list[str]]:
        final_url, text, subpages = _get_page_text(target_url)
        if len(text) > MAX_CONTEXT_CHARS:
            text = text[:MAX_CONTEXT_CHARS] + "\n…[truncated]"
        response = _call_ollama(text_model, _TEXT_PROMPT.format(text=text))
        return final_url, response, subpages

    def _vision_pass() -> tuple[str, str]:
        final_url, image_list = _get_page_images(url)
        if not image_list:
            return final_url, "NO_SCHEDULE"
        imgs_b64 = [base64.b64encode(img).decode() for img in image_list]
        print(f"    vision: {len(imgs_b64)} inline image(s)")
        return final_url, _call_ollama(vision_model, _VISION_PROMPT, images=imgs_b64)

    try:
        if vision_only:
            final_url, response = _vision_pass()
        else:
            # 1. Homepage text pass
            final_url, response, subpages = _text_pass(url)

            # 2. Schedule subpages (up to 5) when homepage has no schedule.
            # Sort same-base-URL entries first (e.g. ?tab=program beats
            # unrelated site-wide links that share a keyword in their path).
            if _is_empty(response) and subpages:
                _base = url.rstrip("/").split("?")[0]
                subpages.sort(
                    key=lambda u: 0 if u.rstrip("/").split("?")[0] == _base else 1
                )
                for sub_url in subpages[:5]:
                    print(f"    subpage: {sub_url}")
                    sub_final, sub_resp, _ = _text_pass(sub_url)
                    if not _is_empty(sub_resp):
                        final_url, response = sub_final, sub_resp
                        break

            # 3. Vision fallback
            if _is_empty(response) and not no_fallback:
                print("    text→NO_SCHEDULE, retrying with vision…")
                final_url, response = _vision_pass()
    except Exception as exc:
        print(f"    ERROR: {exc}")
        return {
            "program_found": False,
            "program_scraped_at": datetime.now(timezone.utc).isoformat(),
        }

    # Normalise the model response
    clean = response.strip()
    # Strip any thinking block that qwen3 might still emit (<think>…</think>)
    clean = re.sub(r"<think>.*?</think>", "", clean, flags=re.DOTALL).strip()

    if not clean or clean.upper().startswith("NO_SCHEDULE"):
        return {
            "program_url": final_url,
            "program_text": None,
            "program_found": False,
            "program_scraped_at": datetime.now(timezone.utc).isoformat(),
        }

    if len(clean) > MAX_PROGRAM_CHARS:
        clean = clean[:MAX_PROGRAM_CHARS].rsplit("\n", 1)[0] + "\n…"

    return {
        "program_url": final_url,
        "program_text": clean,
        "program_found": True,
        "program_scraped_at": datetime.now(timezone.utc).isoformat(),
    }


# ─── Main ─────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help=f"Dry-run: write to {DEBUG_PATH.name} instead of the main JSON, then print diff",
    )
    parser.add_argument(
        "--compare",
        action="store_true",
        help=f"Print comparison from an existing {DEBUG_PATH.name} (no extraction)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-extract all entries (even already-found ones)",
    )
    parser.add_argument(
        "--only-failed",
        action="store_true",
        help="Only (re)process entries where program_found=False",
    )
    parser.add_argument(
        "--vision", action="store_true", help="Vision only — skip text pass entirely"
    )
    parser.add_argument(
        "--no-fallback",
        action="store_true",
        help="Disable automatic vision fallback when text finds nothing",
    )
    parser.add_argument(
        "--model", default=None, help=f"Text model name (default: {DEFAULT_TEXT_MODEL})"
    )
    parser.add_argument(
        "--vision-model",
        default=DEFAULT_VISION_MODEL,
        help=f"Vision model name (default: {DEFAULT_VISION_MODEL})",
    )
    parser.add_argument(
        "--max", type=int, default=None, help="Stop after N entries (for quick testing)"
    )
    parser.add_argument(
        "--url",
        default=None,
        help="Extract from a single URL and print result (no JSON write)",
    )
    args = parser.parse_args()

    text_model = args.model or DEFAULT_TEXT_MODEL
    vision_model = args.vision_model

    # ── Compare-only mode (no Ollama needed) ─────────────────────────────────
    if args.compare:
        _print_comparison(DEBUG_PATH)
        return

    _check_ollama(text_model)
    if vision_model != text_model:
        _check_ollama(vision_model)

    # ── Ad-hoc single-URL mode ────────────────────────────────────────────────
    if args.url:
        mode = (
            "vision"
            if args.vision
            else ("text" if args.no_fallback else "text+vision fallback")
        )
        print(f"Text model : {text_model}  |  Vision model: {vision_model}")
        print(f"Mode       : {mode}")
        print(f"URL        : {args.url}\n")
        result = _extract(
            {"website": args.url},
            text_model,
            vision_model,
            vision_only=args.vision,
            no_fallback=args.no_fallback,
        )
        print("program_found:", result.get("program_found"))
        print("\n--- program_text ---")
        print(result.get("program_text") or "(none)")
        return

    # ── Batch mode ────────────────────────────────────────────────────────────
    data = json.loads(JSON_PATH.read_text())
    all_events = data["workshops"] + data["tutorials"]

    # In debug mode always process all events that have a website so the
    # comparison covers the full picture; --force overrides the default skip.
    queue = []
    for ev in all_events:
        if not ev.get("website"):
            continue
        if ev.get("manually_adjusted"):
            continue  # always preserve manually adjusted entries
        if args.debug or args.force:
            queue.append(ev)
        elif args.only_failed:
            if not ev.get("program_found"):
                queue.append(ev)
        else:
            if not ev.get("program_found"):
                queue.append(ev)

    if args.max:
        queue = queue[: args.max]

    mode = (
        "vision"
        if args.vision
        else ("text" if args.no_fallback else "text+vision fallback")
    )
    print(f"Text model  : {text_model}")
    print(f"Vision model: {vision_model}")
    print(f"Mode        : {mode}")
    print(
        f"Debug       : {'yes → ' + DEBUG_PATH.name if args.debug else 'no (writing to main JSON)'}"
    )
    print(f"Queue       : {len(queue)} events\n")

    found = 0
    debug_records: list[dict] = []

    for i, ev in enumerate(queue, 1):
        title = (ev.get("title") or "?")[:60]
        url = ev.get("website") or ""
        print(f"[{i:3d}/{len(queue)}] {title}")
        print(f"         {url}")

        updates = _extract(
            ev,
            text_model,
            vision_model,
            vision_only=args.vision,
            no_fallback=args.no_fallback,
        )

        status = "FOUND" if updates.get("program_found") else "not found"
        print(f"         → {status}\n")
        if updates.get("program_found"):
            found += 1

        if args.debug:
            debug_records.append(
                {
                    "title": ev.get("title", ""),
                    "website": url,
                    "old_found": bool(ev.get("program_found")),
                    "old_text": ev.get("program_text"),
                    "new_found": bool(updates.get("program_found")),
                    "new_text": updates.get("program_text"),
                    "new_url": updates.get("program_url"),
                }
            )
            # Incremental save of debug file every 5 events
            if i % 5 == 0:
                DEBUG_PATH.write_text(
                    json.dumps(
                        {
                            "run_at": datetime.now(timezone.utc).isoformat(),
                            "model": text_model,
                            "mode": mode,
                            "results": debug_records,
                        },
                        indent=2,
                        ensure_ascii=False,
                    )
                )
                print(f"  [debug saved at {i}]\n")
        else:
            ev.update(updates)
            # Incremental save of main JSON every 5 events
            if i % 5 == 0:
                JSON_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False))
                print(f"  [saved at {i}]\n")

    if args.debug:
        DEBUG_PATH.write_text(
            json.dumps(
                {
                    "run_at": datetime.now(timezone.utc).isoformat(),
                    "model": text_model,
                    "mode": mode,
                    "results": debug_records,
                },
                indent=2,
                ensure_ascii=False,
            )
        )
        print(f"Debug results saved → {DEBUG_PATH}")
        _print_comparison(DEBUG_PATH)
    else:
        JSON_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False))
        print(f"Done. Found: {found}/{len(queue)}")
        print(f"Saved → {JSON_PATH}")


if __name__ == "__main__":
    main()
