"""
CVPR 2026 Workshop & Tutorial extractor (v3 — column-aware, page-level type).
"""

import json
import re
from pathlib import Path

import pdfplumber

try:
    import requests
    from bs4 import BeautifulSoup

    _HTTP_AVAILABLE = True
except ImportError:
    _HTTP_AVAILABLE = False

PDF_PATH = Path(__file__).parent / "CVPR_workshops_tutorials_2026_14.pdf"
OUTPUT_PATH = Path(__file__).parent / "cvpr2026_workshops_tutorials.json"

DATE_MAP = {
    "6/3/2026": "Wednesday, June 3, 2026",
    "6/4/2026": "Thursday, June 4, 2026",
}

# ─────────────────────────────────────────────────────────────────────────────
# Fetch official title → URL mappings from cvpr.thecvf.com
# ─────────────────────────────────────────────────────────────────────────────

_SCHED_RE = re.compile(r"^(wed|thu|full\s*day|half\s*day|am$|pm$)", re.I)
_NAV_DOMAINS = {
    "visitdenver.com",
    "hallerickson.ungerboeck.com",
    "thecvf.com",
    "computer.org",
    "linkedin.com",
    "twitter.com",
    "facebook.com",
    "instagram.com",
    "youtube.com",
}
# Use exact-boundary match: exclude "ieee.org" and "www.ieee.org" but NOT "grss-ieee.org"
_NAV_DOMAINS_EXACT = {"ieee.org", "www.ieee.org"}


def _fetch_cvpr_page_urls(page_url: str) -> dict[str, str]:
    """Return {title: website_url} scraped from a CVPR 2026 Workshops or Tutorials page.

    Each row in those pages has the workshop/tutorial title as a hyperlink to
    the external website, followed by schedule-badge links pointing to the same
    URL.  We group by URL, take the longest anchor text (= the title), and
    discard navigation / schedule noise.
    """
    r = requests.get(page_url, headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    by_url: dict[str, list[str]] = {}
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if not href.startswith("http"):
            continue
        domain = re.sub(r"https?://([^/]+).*", r"\1", href).lower()
        if domain in _NAV_DOMAINS_EXACT:
            continue
        if any(domain == nd or domain.endswith("." + nd) for nd in _NAV_DOMAINS):
            continue
        text = a.get_text(strip=True)
        if not text or _SCHED_RE.match(text):
            continue
        by_url.setdefault(href, []).append(text)

    result: dict[str, str] = {}
    for href, texts in by_url.items():
        title = max(texts, key=len)
        if len(title) > 10:
            result[title] = href
    return result


def load_cvpr_official_urls() -> tuple[dict[str, str], dict[str, str]]:
    """Return (tutorial_urls, workshop_urls) fetched from the CVPR website.

    tutorial_urls  — lowercased title → URL
    workshop_urls  — original-case title → URL

    Falls back to empty dicts if requests/bs4 are unavailable or the fetch
    fails (e.g. offline), so the rest of the pipeline still runs.
    """
    if not _HTTP_AVAILABLE:
        print("  [warn] requests/beautifulsoup4 not installed — skipping URL fetch")
        return {}, {}
    try:
        t_raw = _fetch_cvpr_page_urls(
            "https://cvpr.thecvf.com/Conferences/2026/Tutorials"
        )
        w_raw = _fetch_cvpr_page_urls(
            "https://cvpr.thecvf.com/Conferences/2026/Workshops"
        )
        tutorial_urls = {t.lower(): u for t, u in t_raw.items()}
        workshop_urls = w_raw  # kept in original case for canonical-title correction
        print(
            f"  Fetched from CVPR website: {len(tutorial_urls)} tutorials, {len(workshop_urls)} workshops"
        )
        return tutorial_urls, workshop_urls
    except Exception as exc:
        print(
            f"  [warn] Could not fetch CVPR website URLs ({exc}) — websites will be None"
        )
        return {}, {}


_URL_RE = re.compile(r"https?://[^\s\n\)\]>\"'`]+")


def _ws(s):
    return re.sub(r"\s+", " ", s).strip()


def _urls(text):
    raw = _URL_RE.findall(text)
    return list(dict.fromkeys(u.rstrip(".,;:)") for u in raw))


_NOISE_RE = re.compile(
    r"^(\s*=== PAGE\s|\d+\s*\|\s*CVPR|PROGRAM GUIDE|TABLE OF CONTENTS"
    r"|Tracks and Workshops|NOTE:\s*Tutorial"
    r"|WORKSHOPS?\s*$|TUTORIALS?\s*$"
    r"|(WEDNESDAY|THURSDAY),\s*JUNE\s*[34]\s*$"
    r"|WORKSHOPS?\s+(WEDNESDAY|THURSDAY)"
    r"|TUTORIALS?\s+(WEDNESDAY|THURSDAY))",
    re.IGNORECASE,
)

# ─────────────────────────────────────────────────────────────────────────────
# Column extraction
# ─────────────────────────────────────────────────────────────────────────────


def get_columns(pdf_path):
    cols = []
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages):
            w, h = page.width, page.height
            lt = (
                page.crop((0, 0, w / 2, h)).extract_text(x_tolerance=3, y_tolerance=3)
                or ""
            )
            rt = (
                page.crop((w / 2, 0, w, h)).extract_text(x_tolerance=3, y_tolerance=3)
                or ""
            )
            cols.append((i + 1, lt, rt))
    return cols


# ─────────────────────────────────────────────────────────────────────────────
# Identify tutorial pages (page-level, not column-level)
# ─────────────────────────────────────────────────────────────────────────────


def get_tutorial_pages(columns):
    pages = set()
    for pnum, lt, rt in columns:
        both = lt + "\n" + rt
        if re.search(r"^\s*TUTORIALS?\s*$", both, re.MULTILINE | re.I):
            pages.add(pnum)
    return pages


# ─────────────────────────────────────────────────────────────────────────────
# Entry parser — works on a single column text
# ─────────────────────────────────────────────────────────────────────────────


def parse_column(col_text, page_num, tutorial_pages):
    entries = []
    lines = col_text.split("\n")
    n = len(lines)
    # Start in tutorial section if on a tutorial page; in-column headers can override
    in_tutorial_section = page_num in tutorial_pages

    i = 0
    while i < n:
        s_cur = lines[i].strip()
        # Track section changes within the column
        if re.match(r"^\s*TUTORIALS?\s*$", s_cur, re.I):
            in_tutorial_section = True
            i += 1
            continue
        if re.match(r"^\s*WORKSHOPS?\s*$", s_cur, re.I):
            in_tutorial_section = False
            i += 1
            continue

        dm = re.match(r"\s*Date:\s*(6/[34]/2026)\s*$", s_cur)
        if not dm:
            i += 1
            continue
        date = dm.group(1)
        # Snapshot: summary scan below may flip in_tutorial_section before
        # entry_type is assigned, so capture the state here.
        entry_in_tutorial_section = in_tutorial_section

        # Forward: Time:
        j = i + 1
        while j < n and not lines[j].strip():
            j += 1
        if j >= n or not re.match(r"\s*Time:\s+\S", lines[j]):
            i += 1
            continue
        time_raw = re.sub(r"^\s*Time:\s*", "", lines[j]).strip()

        # Forward: Location:
        k = j + 1
        while k < n and not lines[k].strip():
            k += 1
        if k >= n or not re.match(r"\s*Location:\s+\S", lines[k]):
            i += 1
            continue
        location = _ws(re.sub(r"^\s*Location:\s*", "", lines[k]))

        # Forward: Summary:
        m = k + 1
        while m < n and not lines[m].strip():
            m += 1
        if m >= n or not re.match(r"\s*Summary:\s*", lines[m].strip()):
            i += 1
            continue

        # Collect summary text
        summ_parts = [re.sub(r"^\s*Summary:\s*", "", lines[m]).strip()]
        si = m + 1
        while si < n:
            sl = lines[si].strip()
            if re.match(r"\s*Date:\s*6/[34]/2026", sl):
                break
            if re.match(r"\s*(Time|Location):\s+\S", sl):
                break
            # Track section header transitions (don't include in summary text)
            if re.match(r"^\s*TUTORIALS?\s*$", sl, re.I):
                in_tutorial_section = True
                si += 1
                continue
            if re.match(r"^\s*WORKSHOPS?\s*$", sl, re.I):
                in_tutorial_section = False
                si += 1
                continue
            if sl:
                summ_parts.append(sl)
            si += 1
        summary = _ws(" ".join(summ_parts))

        # ── Backward pass: find Organizers + Title ──
        look_start = max(0, i - 18)
        pre = lines[look_start:i]

        # Find last Organizers: line
        org_idx = None
        for p in range(len(pre) - 1, -1, -1):
            if re.match(r"\s*Organizers?\s*:", pre[p], re.I):
                org_idx = p
                break

        if org_idx is not None:
            raw_org = " ".join(l.strip() for l in pre[org_idx:] if l.strip())
            org_text = _ws(re.sub(r"Organizers?\s*:\s*", "", raw_org, flags=re.I))
            title_pre = pre[:org_idx]
        else:
            org_text = None
            title_pre = pre

        # Collect title lines backwards — stop at noise / sentence-end / schedule text
        _PREP_RE = re.compile(
            r"^(of |and |in |for |to |the |a |an |with |by |on |from |at |as |its |via )",
            re.I,
        )
        title_parts = []
        for l in reversed(title_pre):
            s = l.strip()
            if not s:
                if title_parts:
                    break
                continue
            if _NOISE_RE.match(s):
                break
            # Skip URL lines — don't break, don't include in title
            if re.match(r"https?://", s, re.I):
                continue
            # Schedule-like lines (time ranges) — stop
            if re.match(r"^\d+:\d+\s*[-–]", s):
                break
            # Line ending with period = end of a sentence (previous summary)
            if s.endswith("."):
                m2 = re.search(r"\.\s+([A-Z0-9].+)$", s)
                if m2:
                    title_parts.append(m2.group(1).strip())
                break
            if s[0].islower():
                # Short preposition/conjunction: likely a wrapped title continuation
                if len(s) <= 70 and _PREP_RE.match(s):
                    title_parts.append(s)
                    continue
                # Otherwise it's narrative summary text
                break
            # Line looks like sentence embedding (has ". [Uppercase]" in middle)
            m2 = re.search(r"^.+\.\s+([A-Z].+)$", s)
            if m2 and re.search(r"[a-z]{4,}", s[: s.rfind(". ")]):
                title_parts.append(m2.group(1).strip())
                break
            title_parts.append(s)

        title_parts.reverse()
        title = _ws(" ".join(title_parts))

        if not title or len(title) < 6:
            i = si
            continue

        # Duration normalisation
        tl = time_raw.lower()
        if "full" in tl:
            duration = "Full Day"
        elif "am" in tl:
            duration = "AM (Half Day – Morning)"
        elif "pm" in tl:
            duration = "PM (Half Day – Afternoon)"
        else:
            duration = time_raw

        # Page-level: tutorial pages host both tutorials AND (on transition pages)
        # some workshops that flow in after the tutorial section ends.
        # Title heuristic: if classified as Tutorial but title contains "workshop",
        # it's a workshop that happens to sit on a tutorial page.
        if entry_in_tutorial_section and re.search(r"\bworkshop\b", title, re.I):
            entry_type = "Workshop"
        elif entry_in_tutorial_section:
            entry_type = "Tutorial"
        else:
            entry_type = "Workshop"

        block_text = (org_text or "") + " " + summary
        urls = _urls(block_text)

        entries.append(
            {
                "_page": page_num,
                "type": entry_type,
                "title": title,
                "organizers": org_text,
                "date": date,
                "date_full": DATE_MAP.get(date, date),
                "time_slot": time_raw,
                "duration": duration,
                "location": location,
                "summary": summary or None,
                "website": urls[0] if urls else None,
                "all_urls": urls,
                "track": None,
            }
        )

        i = si

    return entries


# ─────────────────────────────────────────────────────────────────────────────
# Website / classification helpers using official CVPR 2026 website data
# ─────────────────────────────────────────────────────────────────────────────


def _norm(s):
    """Lowercase + collapse non-alphanumeric runs to single spaces."""
    return re.sub(r"\W+", " ", s.lower()).strip()


def _find_tutorial_url(title, tutorial_urls):
    """Return official website URL if *title* matches a known tutorial, else None."""
    t = _norm(title)
    # Pre-compute the prefix before ':' for subtitle-variation matching
    t_prefix = _norm(title.split(":")[0]) if ":" in title else None
    for key, url in tutorial_urls.items():
        k = _norm(key)
        if t == k:
            return url
        # Handle subtitle discrepancies: match when one normalised form contains the other
        if min(len(t), len(k)) >= 15 and (k in t or t in k):
            return url
        # Match on the base title (before colon) when both have a subtitle
        if t_prefix and len(t_prefix) >= 15:
            k_prefix = _norm(key.split(":")[0]) if ":" in key else k
            if t_prefix == k_prefix:
                return url
        # Word-overlap fallback (>60% Jaccard on 4+ char words)
        tw = set(re.findall(r"\w{4,}", t))
        kw = set(re.findall(r"\w{4,}", k))
        if tw and kw and len(tw & kw) / len(tw | kw) > 0.6:
            return url
    return None


def _find_workshop_url(title, workshop_urls):
    """Return (url, canonical_title_or_None) for a workshop, or (None, None)."""
    t = _norm(title)
    for key, url in workshop_urls.items():
        k = _norm(key)
        if t == k:
            return url, None
        if min(len(t), len(k)) >= 15 and (k in t or t in k):
            # If the extracted title is a suffix/substring of the canonical title,
            # return the full canonical title so callers can fix it.
            canonical = key if (k.endswith(t) and len(key) > len(title) + 5) else None
            return url, canonical
    # Word-overlap fallback (higher threshold to avoid false positives)
    tw = set(re.findall(r"\w{5,}", t))
    if not tw:
        return None, None
    best, best_s, best_key = None, 0.0, None
    for key, url in workshop_urls.items():
        kw = set(re.findall(r"\w{5,}", _norm(key)))
        if not kw:
            continue
        s = len(tw & kw) / len(tw | kw)
        if s > best_s and s > 0.55:
            best, best_s, best_key = url, s, key
    return best, None


# ─────────────────────────────────────────────────────────────────────────────
# TOC: build title → track mapping (from left-column of pages 5-10)
# ─────────────────────────────────────────────────────────────────────────────

_SKIP_TOC_RE = re.compile(
    r"^(TABLE OF CONTENTS|Tracks and Workshops|Date\s+Time|PROGRAM GUIDE"
    r"|WORKSHOPS? &|MESSAGE FROM|TUTORIALS?$|WORKSHOPS?$|\d+\s*\|\s*CVPR"
    r"|Workshop Chairs|Tutorial Chairs|NOTE:)",
    re.IGNORECASE,
)
_TRACK_LABEL_RE = re.compile(r"^Track on\s+(.+)", re.IGNORECASE)


def build_track_map(pdf_path):
    track_map = {}
    with pdfplumber.open(pdf_path) as pdf:
        for pi in range(4, 11):
            page = pdf.pages[pi]
            w, h = page.width, page.height
            left = (
                page.crop((0, 0, w / 2, h)).extract_text(x_tolerance=3, y_tolerance=3)
                or ""
            )

            current_track = "General"
            buf = []

            def flush():
                if buf:
                    t = _ws(" ".join(buf))
                    if t:
                        track_map[t.lower()] = current_track
                    buf.clear()

            for line in left.split("\n"):
                s = line.strip()
                tm = _TRACK_LABEL_RE.match(s)
                if tm:
                    flush()
                    current_track = "Track on " + tm.group(1).strip()
                    continue
                if not s or _SKIP_TOC_RE.match(s):
                    flush()
                    continue
                clean = re.sub(r"\.{3,}\s*$", "", s).strip()
                if clean:
                    buf.append(clean)
                if re.search(r"\.{3,}\s*$", s):
                    flush()
            flush()

    return track_map


def match_track(title, track_map):
    key = title.lower()
    for tk, tv in track_map.items():
        if key[:50] in tk or tk[:50] in key:
            return tv
    kw = set(re.findall(r"\w{4,}", key))
    best, best_s = None, 0.0
    for tk, tv in track_map.items():
        tw = set(re.findall(r"\w{4,}", tk))
        if not tw:
            continue
        s = len(kw & tw) / (len(kw | tw) or 1)
        if s > best_s and s > 0.3:
            best, best_s = tv, s
    return best


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────


def main():
    print(f"Reading: {PDF_PATH}")
    columns = get_columns(PDF_PATH)
    print(f"  Pages: {len(columns)}")

    tutorial_pages = get_tutorial_pages(columns)
    print(f"  Tutorial pages: {sorted(tutorial_pages)}")

    track_map = build_track_map(PDF_PATH)
    print(f"  Track map entries: {len(track_map)}")

    tutorial_urls, workshop_urls = load_cvpr_official_urls()

    raw = []
    for pnum, lt, rt in columns:
        raw += parse_column(lt, pnum, tutorial_pages)
        raw += parse_column(rt, pnum, tutorial_pages)
    print(f"  Raw blocks found: {len(raw)}")

    # Deduplicate — prefer longer summary
    seen = {}
    for e in raw:
        key = e["title"].lower()[:55]
        if key not in seen:
            seen[key] = e
        elif len(e.get("summary") or "") > len(seen[key].get("summary") or ""):
            seen[key] = e

    entries = list(seen.values())

    # Post-process: authoritative classification + website URLs from cvpr.thecvf.com
    for e in entries:
        e.pop("_page", None)
        # Validate any URL already on the entry (require a dot in the host)
        if e.get("website"):
            m = re.match(r"https?://([^/\s?#]+)", e["website"])
            if not m or "." not in m.group(1):
                e["website"] = None
        tutorial_url = _find_tutorial_url(e["title"], tutorial_urls)
        if tutorial_url:
            e["type"] = "Tutorial"
            e["track"] = None
            e["website"] = tutorial_url  # always use authoritative URL
        else:
            e["type"] = "Workshop"
            e["track"] = match_track(e["title"], track_map)
            found, canonical_title = _find_workshop_url(e["title"], workshop_urls)
            if found:
                e["website"] = found  # authoritative URL overrides PDF extraction
            if canonical_title:
                e["title"] = (
                    canonical_title  # restore full title if PDF only captured a suffix
                )

    entries.sort(
        key=lambda x: (x.get("date", ""), x.get("type", ""), x.get("title", ""))
    )

    workshops = [e for e in entries if e["type"] == "Workshop"]
    tutorials = [e for e in entries if e["type"] == "Tutorial"]

    output = {
        "conference": "CVPR 2026",
        "venue": "Denver Convention Center, Denver, Colorado, USA",
        "workshop_days": ["Wednesday, June 3, 2026", "Thursday, June 4, 2026"],
        "note": "All times are Mountain Daylight Time (MDT, UTC-6)",
        "total_workshops": len(workshops),
        "total_tutorials": len(tutorials),
        "workshops": workshops,
        "tutorials": tutorials,
    }

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\nSaved → {OUTPUT_PATH}")
    print(f"  Workshops : {len(workshops)}")
    print(f"  Tutorials : {len(tutorials)}")

    print("\n=== TUTORIALS ===")
    for t in tutorials:
        print(f"  [{t['date']}|{t['duration'][:2]}] {t['title']}")

    print("\n=== WORKSHOPS (first 30) ===")
    for w in workshops[:30]:
        trk = (w.get("track") or "—")[:28]
        print(f"  [{w['date']}|{w['duration'][:2]}] [{trk}] {w['title'][:60]}")

    print("\n=== ENTRIES WITH WEBSITE ===")
    for e in workshops + tutorials:
        if e.get("website"):
            print(f"  [{e['type']}] {e['title'][:45]} -> {e['website']}")


if __name__ == "__main__":
    main()
