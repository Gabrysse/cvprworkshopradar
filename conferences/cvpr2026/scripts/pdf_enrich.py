#!/usr/bin/env python3
"""
CVPR 2026 — Ollama-based PDF description & organizer corrector.

For each page of the official CVPR PDF, asks a local Ollama model to
re-extract the title, organizers and description of every workshop/tutorial
on that page, then compares to the existing JSON and updates in-place where
the extracted data differs (e.g. organizer list was wrong, description bled
into the next entry).

Usage:
    python3 conferences/cvpr2026/scripts/pdf_enrich.py                    # process all pages, skip already-verified
    python3 conferences/cvpr2026/scripts/pdf_enrich.py --force            # re-process every entry
    python3 conferences/cvpr2026/scripts/pdf_enrich.py --debug            # dry-run → debug_pdf_extract.json + print diff
    python3 conferences/cvpr2026/scripts/pdf_enrich.py --debug --force    # debug all entries including already-verified
    python3 conferences/cvpr2026/scripts/pdf_enrich.py --page 12          # single page only
    python3 conferences/cvpr2026/scripts/pdf_enrich.py --max 5            # limit to first N content pages
    python3 conferences/cvpr2026/scripts/pdf_enrich.py --model qwen3:8b   # override model

Ollama must be running: `ollama serve`
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import pdfplumber
import requests

CVPR_DIR = Path(__file__).resolve().parents[1]
PDF_PATH = CVPR_DIR / "source" / "CVPR_workshops_tutorials_2026_14.pdf"
JSON_PATH = CVPR_DIR / "data" / "workshops_tutorials.json"
DEBUG_PATH = CVPR_DIR / "data" / "debug_pdf_extract.json"
OLLAMA_URL = "http://localhost:11434/api/generate"

DEFAULT_MODEL = "qwen3.5:9b"

# ─── Prompt ───────────────────────────────────────────────────────────────────

_PDF_PROMPT = """\
Below is the text from one page of the CVPR 2026 Program Guide (workshop and tutorial listings).
The page is split into two columns; both are shown.

Extract every workshop or tutorial entry that appears on this page.
For each entry output a JSON object with these exact keys:
  "title"       — the full workshop or tutorial title (string)
  "organizers"  — comma-separated organizer names (string), or null if not listed
  "description" — the workshop/tutorial description or summary text ONLY (string).
                  IMPORTANT: stop the description the moment the NEXT entry's title
                  line begins. Do NOT copy the next entry's title, organizers, or
                  any text from it into this field. Use null if there is no description.

Output rules:
- Output a JSON array and nothing else. No prose, no markdown fences, no explanation.
- Include ALL entries you can identify on the page, even partial ones at the top or bottom.
- If a field is absent, use null (not an empty string).
- If the description text seems to accidentally include another workshop name or
  an "Organizers:" label for a different workshop, truncate before that point.
- Fix PDF line-break hyphenation: the PDF splits words across lines with a hyphen
  (e.g. "appli- cations", "inter- pretation", "abil- ity", "chal- lenges").
  Rejoin these into single words ("applications", "interpretation", "ability",
  "challenges"). Do NOT remove hyphens from genuine compound words such as
  "state-of-the-art", "real-world", "high-quality", "multi-modal", "end-to-end",
  "fine-grained", "cross-modal", "data-driven", "human-computer", etc.

Page text:
{text}

JSON array:"""

# Stricter retry prompt — used when the first attempt returns malformed JSON.
# Includes an explicit example to help the model get the format right.
_PDF_PROMPT_STRICT = """\
Below is the text from one page of the CVPR 2026 Program Guide.

Extract every workshop or tutorial entry and output ONLY a JSON array.
Each element MUST be a JSON object wrapped in curly braces {{ }}.

Example of the required format (DO NOT copy this data, it is illustrative only):
[
  {{"title": "Workshop on Example Topic", "organizers": "Alice Smith, Bob Jones", "description": "This workshop focuses on..."}},
  {{"title": "Another Workshop", "organizers": null, "description": "Description here."}}
]

Rules:
- "title": full workshop/tutorial title (string)
- "organizers": comma-separated names (string) or null
- "description": description text only — stop BEFORE the next entry's title begins. Never include the next entry's title or organizers in this field.
- Fix PDF line-break hyphenation: rejoin words split across lines with a hyphen (e.g. "appli- cations" → "applications", "inter- preting" → "interpreting"). Keep hyphens in real compound words ("real-world", "state-of-the-art", "multi-modal", etc.).
- Output the JSON array only. Nothing else.

Page text:
{text}

JSON array:"""


# ─── PDF helpers ──────────────────────────────────────────────────────────────


def _extract_page_text(pdf, page_idx: int) -> str:
    """Return combined left+right column text for a 0-based page index."""
    page = pdf.pages[page_idx]
    w, h = page.width, page.height
    lt = page.crop((0, 0, w / 2, h)).extract_text(x_tolerance=3, y_tolerance=3) or ""
    rt = page.crop((w / 2, 0, w, h)).extract_text(x_tolerance=3, y_tolerance=3) or ""
    parts = []
    if lt.strip():
        parts.append("--- Left Column ---\n" + lt.strip())
    if rt.strip():
        parts.append("--- Right Column ---\n" + rt.strip())
    return "\n\n".join(parts)


def _is_content_page(text: str) -> bool:
    """Return True if the page likely contains workshop/tutorial entries."""
    return bool(re.search(r"\bDate:\s*6/[34]/2026", text))


# ─── Ollama helpers ───────────────────────────────────────────────────────────


def _check_ollama(model: str) -> None:
    """Raise SystemExit if Ollama is unreachable or the model is missing."""
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


def _call_ollama(model: str, prompt: str) -> str:
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "think": False,
        "options": {
            "temperature": 0,
            "num_predict": 2048,
        },
    }
    resp = requests.post(OLLAMA_URL, json=payload, timeout=300)
    resp.raise_for_status()
    return resp.json().get("response", "").strip()


def _parse_ollama_json(text: str) -> list[dict]:
    """Extract a JSON array from LLM output, stripping any markdown fences or think-blocks."""
    # Strip <think>…</think> blocks (qwen3 sometimes emits these even with think:false)
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    # Strip markdown fences
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"```\s*$", "", text, flags=re.MULTILINE)
    text = text.strip()

    # Try to find a JSON array anywhere in the response
    m = re.search(r"\[.*\]", text, re.DOTALL)
    if m:
        try:
            result = json.loads(m.group(0))
            if isinstance(result, list):
                return result
        except json.JSONDecodeError:
            pass

    # Direct parse fallback
    try:
        result = json.loads(text)
        if isinstance(result, list):
            return result
    except json.JSONDecodeError:
        pass

    return []


# ─── Title matching ───────────────────────────────────────────────────────────


def _norm(s: str) -> str:
    """Lowercase + collapse non-alphanumeric runs to single spaces."""
    return re.sub(r"\W+", " ", s.lower()).strip()


def _match_entry(extracted_title: str, all_entries: list[dict]) -> int | None:
    """Return the index in all_entries that best matches extracted_title, or None."""
    t = _norm(extracted_title)
    if not t:
        return None

    # 1. Exact normalised match
    for i, ev in enumerate(all_entries):
        if _norm(ev["title"]) == t:
            return i

    # 2. Substring / superset (one contains the other, min 15 chars)
    for i, ev in enumerate(all_entries):
        k = _norm(ev["title"])
        if min(len(t), len(k)) >= 15 and (k in t or t in k):
            return i

    # 3. Jaccard word-overlap on 5+ char words (threshold > 0.55)
    tw = set(re.findall(r"\w{5,}", t))
    if not tw:
        return None
    best_i, best_s = None, 0.0
    for i, ev in enumerate(all_entries):
        kw = set(re.findall(r"\w{5,}", _norm(ev["title"])))
        if not kw:
            continue
        s = len(tw & kw) / len(tw | kw)
        if s > best_s and s > 0.55:
            best_i, best_s = i, s
    return best_i


# ─── Diff helpers ─────────────────────────────────────────────────────────────


def _ws(s: str | None) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def _meaningful_diff(old: str | None, new: str | None) -> bool:
    """Return True if new is non-empty and differs from old after normalisation."""
    new_n = _ws(new)
    if not new_n:
        return False
    return _ws(old) != new_n


def _print_diff(page_num: int, ev: dict, changes: dict) -> None:
    print(f"\n  [p{page_num}] [{ev.get('type', '?')}] {ev['title'][:70]}")
    for field, (old_val, new_val) in changes.items():
        old_s = (old_val or "")[:150].replace("\n", " │ ")
        new_s = (new_val or "")[:150].replace("\n", " │ ")
        print(f"    {field}:")
        print(f"      OLD ▶ {old_s}")
        print(f"      NEW ▶ {new_s}")


def _print_debug_summary(all_changes: list[dict]) -> None:
    if not all_changes:
        print("\nNo differences found.")
        return
    SEP = "─" * 72
    print(f"\n{SEP}")
    print(f"  Total entries with differences : {len(all_changes)}")
    fields_changed: dict[str, int] = {}
    for c in all_changes:
        for f in c["changes"]:
            fields_changed[f] = fields_changed.get(f, 0) + 1
    for f, cnt in sorted(fields_changed.items()):
        print(f"    {f:15s}: {cnt} changed")
    print(SEP)


# ─── Main ─────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help=(
            f"Dry-run: write detected changes to {DEBUG_PATH.name} "
            "instead of updating the JSON"
        ),
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-process entries even if already verified (pdf_ollama_at is set)",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"Ollama model name (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--max",
        type=int,
        default=None,
        help="Stop after N content pages (for quick testing)",
    )
    parser.add_argument(
        "--page",
        type=int,
        default=None,
        help="Process only this specific PDF page number (1-based)",
    )
    args = parser.parse_args()

    _check_ollama(args.model)

    data = json.loads(JSON_PATH.read_text())
    # All entries in a flat list; modifying dicts here modifies data["workshops"]/["tutorials"]
    all_entries: list[dict] = data.get("workshops", []) + data.get("tutorials", [])

    print(f"Model       : {args.model}")
    print(
        f"Debug       : {'yes → ' + DEBUG_PATH.name if args.debug else 'no (writing to main JSON)'}"
    )
    print(f"Force       : {args.force}")
    print(f"JSON entries: {len(all_entries)}\n")

    total_pages_processed = 0
    total_entries_updated = 0
    content_pages_seen = 0
    all_changes: list[dict] = []

    with pdfplumber.open(PDF_PATH) as pdf:
        n_pages = len(pdf.pages)
        print(f"PDF pages   : {n_pages}\n")

        for page_idx in range(n_pages):
            page_num = page_idx + 1  # 1-based

            # Single-page mode
            if args.page is not None and page_num != args.page:
                continue

            text = _extract_page_text(pdf, page_idx)
            if not _is_content_page(text):
                continue

            content_pages_seen += 1
            if args.max is not None and content_pages_seen > args.max:
                print(f"  Reached --max {args.max} content pages, stopping.")
                break

            print(f"Page {page_num:3d}  (content #{content_pages_seen})", end="", flush=True)

            # Call Ollama (with one retry using a stricter prompt on parse failure)
            extracted: list[dict] = []
            for attempt, prompt_template in enumerate(
                [_PDF_PROMPT, _PDF_PROMPT_STRICT]
            ):
                prompt = prompt_template.format(text=text)
                try:
                    raw_response = _call_ollama(args.model, prompt)
                except Exception as exc:
                    print(f"  — Ollama error: {exc}")
                    raw_response = ""
                    break
                extracted = _parse_ollama_json(raw_response)
                if extracted:
                    break
                if attempt == 0:
                    print(f"  — parse failed, retrying with strict prompt…", end="", flush=True)

            if not extracted:
                print(f"  — no JSON parsed after retry (response: {raw_response[:80]!r})")
                continue

            print(
                f"  → {len(extracted)} entr{'y' if len(extracted) == 1 else 'ies'} from LLM",
                end="",
            )

            page_updates = 0
            for ex in extracted:
                ex_title = _ws(ex.get("title") or "")
                if not ex_title or len(ex_title) < 6:
                    continue

                idx = _match_entry(ex_title, all_entries)
                if idx is None:
                    continue

                ev = all_entries[idx]

                # Skip already-verified unless --force
                if not args.force and ev.get("pdf_ollama_at"):
                    continue

                changes: dict[str, tuple] = {}

                new_org = _ws(ex.get("organizers") or "")
                if _meaningful_diff(ev.get("organizers"), new_org):
                    changes["organizers"] = (ev.get("organizers"), new_org)

                new_desc = _ws(ex.get("description") or "")
                if _meaningful_diff(ev.get("summary"), new_desc):
                    changes["summary"] = (ev.get("summary"), new_desc)

                if not changes:
                    continue

                if args.debug:
                    all_changes.append(
                        {
                            "page": page_num,
                            "title": ev["title"],
                            "type": ev.get("type", "?"),
                            "changes": {
                                f: {"old": o, "new": n}
                                for f, (o, n) in changes.items()
                            },
                        }
                    )
                    _print_diff(page_num, ev, changes)
                else:
                    for field, (_, new_val) in changes.items():
                        ev[field] = new_val
                    ev["pdf_ollama_at"] = datetime.now(timezone.utc).isoformat()

                page_updates += 1
                total_entries_updated += 1

            print(f", {page_updates} updated")
            total_pages_processed += 1

    print(f"\nContent pages processed : {total_pages_processed}")
    print(f"Entries with changes    : {total_entries_updated}")

    if args.debug:
        debug_out = {
            "run_at": datetime.now(timezone.utc).isoformat(),
            "model": args.model,
            "pages_processed": total_pages_processed,
            "total_changes": total_entries_updated,
            "changes": all_changes,
        }
        DEBUG_PATH.write_text(json.dumps(debug_out, indent=2, ensure_ascii=False))
        print(f"\nDebug output written to {DEBUG_PATH.name}")
        _print_debug_summary(all_changes)
    else:
        if total_entries_updated > 0:
            JSON_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False))
            print(f"JSON saved  → {JSON_PATH.name}")
        else:
            print("No changes to save.")


if __name__ == "__main__":
    main()
