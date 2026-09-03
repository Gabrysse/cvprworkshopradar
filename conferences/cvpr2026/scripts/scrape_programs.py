"""
CVPR 2026 — Workshop & Tutorial program scraper.

For each event that has a website, this script:
  1. Fetches the homepage with requests + BeautifulSoup
  2. Looks for a schedule / program / agenda section or subpage link
  3. Extracts plain-text content from that section
  4. Writes back the following new fields to the CVPR conference JSON:
       program_url         – URL where the program was found
       program_text        – cleaned plain text (≤ 4 000 chars)
       program_scraped_at  – ISO-8601 UTC timestamp
       program_found       – bool

Usage:
    python3 conferences/cvpr2026/scripts/scrape_programs.py                      # skip already-scraped entries
    python3 conferences/cvpr2026/scripts/scrape_programs.py --force              # re-scrape everything (skips manually_adjusted entries)
    python3 conferences/cvpr2026/scripts/scrape_programs.py --retry-failed       # re-scrape only program_found=False entries
    python3 conferences/cvpr2026/scripts/scrape_programs.py --js                 # after static pass, run Playwright on failures
    python3 conferences/cvpr2026/scripts/scrape_programs.py --retry-failed --js  # static + JS retry of all failures
    python3 conferences/cvpr2026/scripts/scrape_programs.py --max 20             # only scrape first N entries (for testing)

Playwright setup (one-time, ~200 MB):
    pip install playwright && playwright install chromium
"""

import argparse
import copy
import json
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

try:
    import requests
    from bs4 import BeautifulSoup, NavigableString, Tag
except ImportError:
    sys.exit("Missing dependencies. Run:\n  pip install requests beautifulsoup4 lxml\n")

import csv
import io

_PW_AVAILABLE = False
try:
    from playwright.sync_api import TimeoutError as _PwTimeout
    from playwright.sync_api import sync_playwright

    _PW_AVAILABLE = True
except ImportError:
    pass

# ─── Config ──────────────────────────────────────────────────────────────────
JSON_PATH = Path(__file__).resolve().parents[1] / "data" / "workshops_tutorials.json"
MAX_WORKERS = 10  # concurrent HTTP workers
REQUEST_TIMEOUT = 12  # seconds per request
MAX_PROGRAM_CHARS = 4_000  # cap stored text length
SAVE_INTERVAL = 20  # save JSON every N completed items

# Keywords that indicate a schedule / program page or section
SCHEDULE_KEYWORDS = [
    "schedule",
    "program",
    "programme",
    "agenda",
    "timetable",
    "sessions",
    "talks",
    "invited talks",
    "paper sessions",
]

# Heading tags to search for schedule sections
HEADING_TAGS = ("h1", "h2", "h3", "h4")

# Regex for embedded Google Sheets.
# Captures two groups: (1) 'e' if it's a published sheet, else None;
# (2) the sheet/published ID.
# Handles both:
#   regular:   docs.google.com/spreadsheets/d/{SHEET_ID}/...
#   published: docs.google.com/spreadsheets/d/e/{PUBLISHED_ID}/pubhtml...
_GSHEETS_RE = re.compile(r"docs\.google\.com/spreadsheets/d/(?:(e)/)?([a-zA-Z0-9_-]+)")

# Headings whose text matches a schedule keyword but are NOT schedule sections
_NEGATIVE_SCHEDULE_PHRASES = (
    "technical program committee",
    "program committee",
    "program chair",
    "program co-chair",
    "organizing committee",
    "papers program",  # CFP/submission section, not a session schedule
)

# Domains to ignore when looking for subpage links
_SKIP_DOMAINS = {
    "twitter.com",
    "x.com",
    "facebook.com",
    "instagram.com",
    "linkedin.com",
    "youtube.com",
    "github.com",
    "thecvf.com",
    "cvpr.thecvf.com",
}

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

# ─── Shared state ─────────────────────────────────────────────────────────────
_lock = threading.Lock()
_counter = {"done": 0, "found": 0, "not_found": 0, "error": 0}


# ─── Utilities ────────────────────────────────────────────────────────────────


def _clean_text(text: str, max_chars: int = MAX_PROGRAM_CHARS) -> str:
    """Collapse whitespace and cap length."""
    # Normalise line breaks
    text = re.sub(r"\r\n|\r", "\n", text)
    # Collapse multiple blank lines → single blank line
    text = re.sub(r"\n{3,}", "\n\n", text)
    # Collapse repeated spaces / tabs on a single line
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = text.strip()
    if len(text) > max_chars:
        text = text[:max_chars].rsplit("\n", 1)[0] + "\n…"
    return text


def _is_schedule_heading(tag: Tag) -> bool:
    """Return True if a heading element's text suggests a schedule section."""
    text = tag.get_text(separator=" ", strip=True).lower()
    if any(phrase in text for phrase in _NEGATIVE_SCHEDULE_PHRASES):
        return False
    # Require keyword at a word boundary to avoid matching "ScheduleCall" nav blobs
    return any(
        re.search(r"\b" + re.escape(kw) + r"\b", text) for kw in SCHEDULE_KEYWORDS
    )


def _heading_level(tag: Tag) -> int:
    try:
        return int(tag.name[1])
    except (IndexError, ValueError):
        return 99


def _extract_section_after_heading(heading: Tag) -> str:
    """Collect text from siblings after `heading` until the next same-or-higher heading.

    If the heading has no content among its direct siblings (e.g. WordPress pages
    where the h1 sits inside a title-wrapper div and the actual content lives in a
    sibling div), bubble up one level and collect the parent's next siblings instead.
    """
    level = _heading_level(heading)
    heading_text = heading.get_text(separator=" ", strip=True)

    def _collect_siblings(node: Tag, stop_level: int) -> list[str]:
        parts: list[str] = []
        for sib in node.find_next_siblings():
            if isinstance(sib, NavigableString):
                t = sib.strip()
                if t:
                    parts.append(t)
                continue
            if sib.name in HEADING_TAGS and _heading_level(sib) <= stop_level:
                break
            # Skip purely navigational blocks
            if sib.get("role") in ("navigation", "banner", "contentinfo"):
                continue
            cls = " ".join(sib.get("class", []))
            if any(
                x in cls.lower()
                for x in ("nav", "footer", "header", "cookie", "banner")
            ):
                continue
            parts.append(sib.get_text(separator="\n", strip=True))
        return parts

    parts = [heading_text] + _collect_siblings(heading, level)
    result = "\n".join(p for p in parts if p)

    # If the heading yielded no substantive content from its own siblings, the
    # content may be in a parent-level sibling (e.g. WordPress wp-block-group
    # title div + entry-content div).  Bubble up one level and try again.
    if len(result) - len(heading_text) < 30 and heading.parent:
        parent_parts = _collect_siblings(heading.parent, level)
        if parent_parts:
            result = result + "\n" + "\n".join(p for p in parent_parts if p)

    return result


def _find_schedule_by_id_class(soup: BeautifulSoup) -> str | None:
    """
    Look for elements whose id or class attribute contains a schedule keyword.
    Takes priority over heading-based extraction because id/class is explicit
    intent by the site author (e.g. <section id="schedule">, <div class="program">).
    For empty bookmark anchors (<a id="schedule"></a>) the parent container is used.
    """
    for kw in SCHEDULE_KEYWORDS:
        pattern = re.compile(r"(?:^|[^a-z])" + re.escape(kw) + r"(?:[^a-z]|$)")
        for el in soup.find_all(True):
            el_id = el.get("id", "").lower()
            el_class = " ".join(el.get("class", [])).lower()
            if not (pattern.search(el_id) or pattern.search(el_class)):
                continue
            text = el.get_text(separator="\n", strip=True)
            if len(text) > 60:
                return text
            # Empty bookmark anchor — look at the parent container
            if el.name == "a" and not text:
                node = el.parent
                while node and node.name not in ("body", "html", "[document]"):
                    parent_text = node.get_text(separator="\n", strip=True)
                    if len(parent_text) > 60:
                        return parent_text
                    node = node.parent
    return None


def _find_program_in_soup(soup: BeautifulSoup) -> str | None:
    """Return the schedule section text if found, else None."""
    # 1. Explicit id/class anchoring (most precise — checked first)
    result = _find_schedule_by_id_class(soup)
    # Validate: an id/class match without any clock times is likely a CfP,
    # challenge-timeline, or other non-schedule section.  Fall through to
    # heading-based search; return the id/class result as a last resort only
    # if heading search also yields nothing.
    if result and len(re.findall(r"\b\d{1,2}:\d{2}", result)) >= 2:
        return result
    # 2. Heading-based extraction
    for tag in HEADING_TAGS:
        for heading in soup.find_all(tag):
            if _is_schedule_heading(heading):
                text = _extract_section_after_heading(heading)
                if len(text) > 60:  # ignore trivially empty sections
                    return text
    # Last resort: return the id/class result even without clock times
    # (covers tutorial schedules expressed as durations rather than clock times)
    return result


def _extract_full_page_content(
    soup: BeautifulSoup, require_keyword: bool = True
) -> str | None:
    """
    Fallback extractor for pages like Google Sites where the schedule content
    is split across many tiny elements rather than collected under a heading.
    Strips navigation/chrome and returns the body text if it contains schedule
    indicators and is substantial enough to be a real program.

    When *require_keyword* is False the schedule-keyword check is skipped —
    use this for subpages that were explicitly linked as a schedule page.
    """
    body = soup.find("body")
    if body is None:
        return None
    # Work on a copy so we don't mutate the original soup
    body = copy.copy(body)
    # Remove navigation, header, footer, and search chrome
    for el in body.find_all(["nav", "header", "footer"]):
        el.decompose()
    for el in body.find_all(
        attrs={"role": ["navigation", "banner", "contentinfo", "search"]}
    ):
        el.decompose()
    text = body.get_text(separator="\n", strip=True)
    # Google Sites splits individual digit/colon characters across newlines.
    # Normalise patterns like "1\n:\n45" → "1:45" before time counting.
    text_norm = re.sub(r"(\d)\s*\n\s*:\s*\n\s*(\d)", r"\1:\2", text)
    # Must contain at least 2 distinct clock times.
    # Requiring 2+ prevents single venue-time descriptions ("from 1:00 PM")
    # or AoE submission deadlines ("23:59 AoE") from triggering a false positive.
    has_keyword = any(kw in text_norm.lower() for kw in SCHEDULE_KEYWORDS)
    times_found = re.findall(r"\b\d{1,2}:\d{2}", text_norm)
    if (
        (not require_keyword or has_keyword)
        and len(times_found) >= 2
        and len(text) > 200
    ):
        return text
    return None


def _same_origin_program_link(soup: BeautifulSoup, base_url: str) -> str | None:
    """
    Find a same-origin anchor whose text looks like a schedule/program link.
    Returns the absolute URL, or None.
    """
    base_domain = urlparse(base_url).netloc.lower()
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        # Build absolute URL
        abs_url = urljoin(base_url, href)
        link_domain = urlparse(abs_url).netloc.lower()
        if link_domain != base_domain:
            continue
        text = a.get_text(separator=" ", strip=True).lower()
        url_lower = abs_url.lower()
        if any(kw in text or kw in url_lower for kw in SCHEDULE_KEYWORDS):
            return abs_url
    return None


def _fetch_html(url: str) -> BeautifulSoup | None:
    """Fetch a URL and return a BeautifulSoup, or None on failure."""
    try:
        resp = requests.get(
            url, headers=_HEADERS, timeout=REQUEST_TIMEOUT, allow_redirects=True
        )
        resp.raise_for_status()
        ct = resp.headers.get("content-type", "")
        if "html" not in ct.lower():
            return None
        return BeautifulSoup(resp.text, "lxml")
    except Exception:
        try:
            # Retry once with a different parser on failure
            resp = requests.get(
                url, headers=_HEADERS, timeout=REQUEST_TIMEOUT, allow_redirects=True
            )
            return BeautifulSoup(resp.text, "html.parser")
        except Exception:
            return None


# ─── Core scraper per event ───────────────────────────────────────────────────


def scrape_event(event: dict) -> dict:
    """
    Scrape the program for a single event.
    Mutates `event` in-place and returns it.
    """
    website = event.get("website") or ""
    if not website:
        event.update(
            program_url=None,
            program_text=None,
            program_found=False,
            program_scraped_at=datetime.now(timezone.utc).isoformat(),
        )
        return event

    program_text: str | None = None
    program_url: str | None = None

    # --- Step 1: homepage ---
    soup = _fetch_html(website)
    if soup is None:
        event.update(
            program_url=None,
            program_text=None,
            program_found=False,
            program_scraped_at=datetime.now(timezone.utc).isoformat(),
        )
        with _lock:
            _counter["error"] += 1
        return event

    program_text = _find_program_in_soup(soup)
    if program_text:
        program_url = website

    # --- Step 1b: full-page fallback on homepage (handles JS-table layouts) ---
    # Also runs when specific extraction returned something very short (<150 chars)
    # so that sites whose schedule header sits above a JS-rendered table (e.g.
    # datamfm, wdfm) still get the full static-HTML body content.
    if not program_text or len(program_text) < 150:
        t2 = _extract_full_page_content(soup)
        if t2 and len(t2) > len(program_text or ""):
            program_text = t2
            program_url = website

    # --- Step 2: try a subpage link if not found on homepage ---
    if not program_text:
        subpage = _same_origin_program_link(soup, website)
        if subpage and subpage != website:
            sub_soup = _fetch_html(subpage)
            if sub_soup:
                program_text = _find_program_in_soup(sub_soup)
                if not program_text:
                    program_text = _extract_full_page_content(sub_soup)
                if program_text:
                    program_url = subpage

    # --- Finalise ---
    if program_text:
        program_text = _clean_text(program_text)

    event.update(
        program_url=program_url,
        program_text=program_text if program_text else None,
        program_found=bool(program_text),
        program_scraped_at=datetime.now(timezone.utc).isoformat(),
    )

    with _lock:
        if program_text:
            _counter["found"] += 1
        else:
            _counter["not_found"] += 1

    return event


# ─── Google Sheets CSV helper ────────────────────────────────────────────────


def _gsheet_to_text(sheet_id: str, is_published: bool = False) -> str | None:
    """
    Fetch a public Google Sheet as CSV and format it as plain text.
    For published sheets (d/e/{id}/pubhtml), use the pub?output=csv endpoint.
    For regular sheets, use the gviz/tq endpoint.
    """
    if is_published:
        url = (
            f"https://docs.google.com/spreadsheets/d/e/{sheet_id}/pub?output=csv&gid=0"
        )
    else:
        url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq?tqx=out:csv&sheet=0"
    try:
        resp = requests.get(url, headers=_HEADERS, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        resp.encoding = "utf-8"  # force UTF-8; Google Sheets CSV is always UTF-8
        rows = list(csv.reader(io.StringIO(resp.text)))
        # Drop fully empty rows
        rows = [r for r in rows if any(c.strip() for c in r)]
        if not rows:
            return None
        lines = ["  ".join(c.strip() for c in row if c.strip()) for row in rows]
        return "\n".join(l for l in lines if l)
    except Exception:
        return None


# ─── Playwright scraper ───────────────────────────────────────────────────────


def _pw_goto(page, url: str, timeout: int = 25_000) -> bool:
    """Navigate with 'networkidle', fallback to 'domcontentloaded' + short pause."""
    try:
        page.goto(url, wait_until="networkidle", timeout=timeout)
        return True
    except Exception:
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=timeout)
            page.wait_for_timeout(3_000)
            return True
        except Exception:
            return False


def _extract_embedded_doc_from_frames(page) -> str | None:
    """
    Check all about:blank frames for Google Doc content injected via gapi.rpc.
    Google Sites embeds Google Docs into about:blank iframes using document.write()
    called from the atari-embeds infrastructure frame.  These frames have no URL
    but contain rendered HTML with the doc content.
    """
    for frame in page.frames:
        if frame.url not in ("about:blank", ""):
            continue
        try:
            content = frame.content()
            if not content or len(content) < 100:
                continue
            soup = BeautifulSoup(content, "lxml")
            body = soup.find("body")
            if body is None:
                continue
            text = body.get_text(separator="\n", strip=True)
            if len(text) < 100:
                continue
            # Normalize fragmented time patterns (same as _extract_full_page_content)
            text_norm = re.sub(r"(\d)\s*\n\s*:\s*\n\s*(\d)", r"\1:\2", text)
            has_keyword = any(kw in text_norm.lower() for kw in SCHEDULE_KEYWORDS)
            times = re.findall(r"\b\d{1,2}:\d{2}", text_norm)
            if has_keyword and len(times) >= 2:
                return text
        except Exception:
            continue
    return None


def _extract_sheets_from_page(page, program_url: str) -> str | None:
    """
    Check all iframes and frames on the current page for embedded Google Sheets.
    Google Sites embeds sheets via nested frames (not directly in iframe src),
    so we must scan page.frames as well as DOM iframe src attributes.
    """
    seen: set[str] = set()

    def _try_url(url: str) -> str | None:
        m = _GSHEETS_RE.search(url)
        if not m:
            return None
        is_published = m.group(1) == "e"
        sheet_id = m.group(2)
        key = (is_published, sheet_id)
        if key in seen:
            return None
        seen.add(key)
        return _gsheet_to_text(sheet_id, is_published=is_published)

    try:
        # Method 1: DOM iframe src attributes
        for frame_el in page.locator("iframe").all():
            src = frame_el.get_attribute("src") or ""
            text = _try_url(src)
            if text and len(text) > 60:
                return text
        # Method 2: Playwright frame tree (catches nested/JS-injected frames)
        for frame in page.frames:
            text = _try_url(frame.url or "")
            if text and len(text) > 60:
                return text
    except Exception:
        pass
    return None


def scrape_event_playwright(event: dict, page) -> dict:
    """
    Scrape a single event using an already-open Playwright page.
    Strategy:
      1. Navigate to homepage.
      2. Scan iframes for embedded Google Sheets → fetch as CSV.
      3. Run schedule-heading extraction on rendered HTML.
      4. Follow same-origin schedule subpage link and repeat 2+3.
    """
    website = event.get("website") or ""
    if not website:
        event.update(
            program_url=None,
            program_text=None,
            program_found=False,
            program_scraped_at=datetime.now(timezone.utc).isoformat(),
        )
        return event

    program_text: str | None = None
    program_url: str | None = None

    # --- Navigate to homepage ---
    if not _pw_goto(page, website):
        event.update(
            program_url=None,
            program_text=None,
            program_found=False,
            program_scraped_at=datetime.now(timezone.utc).isoformat(),
        )
        with _lock:
            _counter["error"] += 1
        return event

    # --- 1. Google Sheets iframes / embedded Google Docs on homepage ---
    program_text = _extract_sheets_from_page(page, website)
    if not program_text:
        program_text = _extract_embedded_doc_from_frames(page)
    if program_text:
        program_url = website

    # --- 2. Heading/id/class extraction on rendered homepage HTML ---
    if not program_text:
        try:
            soup = BeautifulSoup(page.content(), "lxml")
            program_text = _find_program_in_soup(soup)
            if not program_text or len(program_text) < 150:
                t2 = _extract_full_page_content(soup)
                if t2 and len(t2) > len(program_text or ""):
                    program_text = t2
            if program_text:
                program_url = website
        except Exception:
            pass

    # --- 3. Same-origin subpage ---
    if not program_text:
        try:
            soup = BeautifulSoup(page.content(), "lxml")
            subpage = _same_origin_program_link(soup, website)
            if subpage and subpage != website:
                if _pw_goto(page, subpage, timeout=20_000):
                    # Sheets / embedded Docs in subpage
                    program_text = _extract_sheets_from_page(page, subpage)
                    if not program_text:
                        program_text = _extract_embedded_doc_from_frames(page)
                    if program_text:
                        program_url = subpage
                    # Heading extraction in subpage.
                    # Skip the keyword check since we already know this page
                    # was linked as a schedule/program page.
                    if not program_text:
                        soup2 = BeautifulSoup(page.content(), "lxml")
                        program_text = _find_program_in_soup(soup2)
                        if not program_text:
                            program_text = _extract_full_page_content(
                                soup2, require_keyword=False
                            )
                        if program_text:
                            program_url = subpage
        except Exception:
            pass

    if program_text:
        program_text = _clean_text(program_text)

    event.update(
        program_url=program_url,
        program_text=program_text if program_text else None,
        program_found=bool(program_text),
        program_scraped_at=datetime.now(timezone.utc).isoformat(),
    )

    with _lock:
        if program_text:
            _counter["found"] += 1
        else:
            _counter["not_found"] += 1

    return event


# ─── Save helper ──────────────────────────────────────────────────────────────


def save_json(data: dict) -> None:
    with _lock:
        tmp = JSON_PATH.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        tmp.replace(JSON_PATH)


# ─── Main ──────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Scrape CVPR 2026 workshop/tutorial programs."
    )
    parser.add_argument("--force", action="store_true", help="Re-scrape all entries")
    parser.add_argument(
        "--retry-failed",
        action="store_true",
        help="Re-scrape only program_found=False entries",
    )
    parser.add_argument(
        "--js",
        action="store_true",
        help="Run Playwright on remaining failures after static pass",
    )
    parser.add_argument(
        "--max",
        type=int,
        default=None,
        metavar="N",
        help="Only scrape first N entries (for testing)",
    )
    args = parser.parse_args()

    print(f"Loading {JSON_PATH}")
    with open(JSON_PATH, encoding="utf-8") as f:
        data = json.load(f)

    all_events: list[dict] = data.get("workshops", []) + data.get("tutorials", [])

    # ── Select which events need the static pass ───────────────────────────
    to_scrape: list[dict] = []
    for ev in all_events:
        if ev.get("manually_adjusted"):
            continue  # always preserve manually adjusted entries
        already_scraped = bool(ev.get("program_scraped_at"))
        already_found = bool(ev.get("program_found"))
        if args.force:
            to_scrape.append(ev)
        elif args.retry_failed:
            # Only queue entries that were scraped but found nothing
            if already_scraped and not already_found:
                to_scrape.append(ev)
        else:
            # Default: skip anything already scraped
            if not already_scraped:
                to_scrape.append(ev)
        if args.max and len(to_scrape) >= args.max:
            break

    already_done = sum(1 for e in all_events if e.get("program_scraped_at"))
    print(
        f"Events total : {len(all_events)}  (already scraped: {already_done},  queued: {len(to_scrape)})"
    )

    # ── Static scraping pass ───────────────────────────────────────────────
    if to_scrape:
        t0 = time.time()
        completed = 0
        _counter.update(done=0, found=0, not_found=0, error=0)

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = {executor.submit(scrape_event, ev): ev for ev in to_scrape}
            for future in as_completed(futures):
                future.result()
                completed += 1
                with _lock:
                    _counter["done"] += 1
                pct = completed / len(to_scrape) * 100
                print(
                    f"\r  [{completed}/{len(to_scrape)}  {pct:.0f}%]  "
                    f"found={_counter['found']}  "
                    f"not_found={_counter['not_found']}  "
                    f"errors={_counter['error']}  "
                    f"elapsed={time.time() - t0:.0f}s",
                    end="",
                    flush=True,
                )
                if completed % SAVE_INTERVAL == 0:
                    save_json(data)

        print()
        save_json(data)
        elapsed = time.time() - t0
        print(f"\nStatic pass done in {elapsed:.1f}s")
        print(f"  Found   : {_counter['found']}/{len(to_scrape)}")
        print(f"  Missing : {_counter['not_found']}/{len(to_scrape)}")
        print(f"  Errors  : {_counter['error']}/{len(to_scrape)}")
    else:
        print("  Nothing queued for static pass.")

    # ── Playwright pass ────────────────────────────────────────────────────
    if args.js:
        if not _PW_AVAILABLE:
            print(
                "\n[warn] Playwright not installed. Run:\n"
                "  pip install playwright && playwright install chromium"
            )
        else:
            # All events scraped but still without a program
            pw_targets = [
                ev
                for ev in all_events
                if ev.get("program_scraped_at") and not ev.get("program_found")
            ]
            if args.max:
                pw_targets = pw_targets[: args.max]

            if not pw_targets:
                print(
                    "\nPlaywright: nothing to retry (all events already have a program)."
                )
            else:
                print(f"\nPlaywright pass on {len(pw_targets)} JS-rendered events...")
                _counter.update(done=0, found=0, not_found=0, error=0)
                t1 = time.time()
                completed = 0

                with sync_playwright() as pw:
                    browser = pw.chromium.launch(headless=True)
                    for ev in pw_targets:
                        ctx = browser.new_context(user_agent=_HEADERS["User-Agent"])
                        page = ctx.new_page()
                        try:
                            scrape_event_playwright(ev, page)
                        finally:
                            ctx.close()
                        completed += 1
                        pct = completed / len(pw_targets) * 100
                        print(
                            f"\r  PW [{completed}/{len(pw_targets)}  {pct:.0f}%]  "
                            f"found={_counter['found']}  "
                            f"elapsed={time.time() - t1:.0f}s",
                            end="",
                            flush=True,
                        )
                        if completed % SAVE_INTERVAL == 0:
                            save_json(data)
                    browser.close()

                print()
                save_json(data)
                print(f"Playwright pass done in {time.time() - t1:.1f}s")
                print(f"  Additional found : {_counter['found']}/{len(pw_targets)}")
                print(f"  Still missing    : {_counter['not_found']}/{len(pw_targets)}")
                print(f"  Errors           : {_counter['error']}/{len(pw_targets)}")

    print(f"\nSaved → {JSON_PATH}")


if __name__ == "__main__":
    main()
