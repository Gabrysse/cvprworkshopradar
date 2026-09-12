#!/usr/bin/env python3
"""Create a Workshop Radar JSON file from workshop/tutorial listing pages.

The extractor is intentionally conservative: it records only public event links
and metadata it can identify from the listing. The Ollama stage enriches each
event later from its own website.
"""

import argparse
import json
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": "WorkshopRadar/1.0 (+https://github.com/Gabrysse/workshopradar)"
}
DATE_RE = re.compile(
    r"\b(?:Sep(?:tember)?|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Oct(?:ober)?)\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?",
    re.IGNORECASE,
)
ROOM_RE = re.compile(
    r"(?:In\s+)?Room\s*:\s*([^|\n]+?)(?=\s+(?:on\s+)?(?:Sep|Jun|Jul|Aug|Oct)\.?\s+\d|\||$)",
    re.IGNORECASE,
)
TIME_RE = re.compile(r"\bat\s+\d{1,2}(?::\d{2})?\s*(AM|PM)\b", re.IGNORECASE)
SLOT_RE = re.compile(r"(?:,|\s)(AM|PM)\b", re.IGNORECASE)


def clean(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def is_external_project(url: str, listing_host: str) -> bool:
    host = urlparse(url).netloc.lower()
    return bool(host and host != listing_host and not host.endswith("." + listing_host))


def event_record(
    title: str,
    website: str | None,
    context_text: str,
    event_type: str,
    year: int,
    organizers: str | None = None,
) -> dict | None:
    title = clean(
        re.split(
            r"\b(?:project\s+page|website|details)\b",
            title,
            maxsplit=1,
            flags=re.IGNORECASE,
        )[0]
    )
    if len(title) < 8:
        return None
    date = None
    if match := DATE_RE.search(context_text):
        month_token = match.group(0).split()[0][:3].lower()
        month = {
            "jan": 1,
            "feb": 2,
            "mar": 3,
            "apr": 4,
            "may": 5,
            "jun": 6,
            "jul": 7,
            "aug": 8,
            "sep": 9,
            "oct": 10,
            "nov": 11,
            "dec": 12,
        }.get(month_token)
        if month:
            date = f"{match.group(2) or year}-{month:02d}-{int(match.group(1)):02d}"
    room_match = ROOM_RE.search(context_text)
    # Listing pages also contain global legal/proceedings links. An event row
    # always has a date or an explicit room; do not turn shared links into fake
    # workshops or tutorials.
    if not date and not room_match:
        return None
    if not organizers and "project page" in context_text.lower():
        tail = re.split(
            r"\bproject\s+page\b", context_text, maxsplit=1, flags=re.IGNORECASE
        )[1]
        organizers = (
            clean(
                re.split(
                    r"\b(?:in\s+)?room\s*:", tail, maxsplit=1, flags=re.IGNORECASE
                )[0].replace("↗", "")
            )
            or None
        )
    time_match = TIME_RE.search(context_text)
    slot_match = SLOT_RE.search(context_text)
    time_slot = (
        "Full Day"
        if re.search(r"\bfull\s+day\b", context_text, re.IGNORECASE)
        else (
            time_match.group(1).upper()
            if time_match
            else (slot_match.group(1).upper() if slot_match else None)
        )
    )
    return {
        "type": event_type,
        "title": title,
        "organizers": organizers,
        "organizers_source": "official_listing" if organizers else None,
        "date": date,
        "date_full": datetime.fromisoformat(date)
        .strftime("%A, %B %d, %Y")
        .replace(" 0", " ")
        if date
        else None,
        "time_slot": time_slot,
        "duration": "Full Day" if time_slot == "Full Day" else None,
        "location": clean(room_match.group(1)) if room_match else None,
        "summary": None,
        "track": None,
        "website": website,
        "program_found": False,
    }


def listing_entries(url: str, event_type: str, year: int) -> list[dict]:
    response = requests.get(url, headers=HEADERS, timeout=25)
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "html.parser")
    listing_host = urlparse(response.url).netloc.lower()

    # ECCV's canonical listings use event rows. Parse rows first so entries
    # with no project website remain in the initial list.
    table_entries = []
    for row in soup.find_all("tr"):
        cells = row.find_all("td", recursive=False)
        context_text = clean(row.get_text(" ", strip=True))
        if not cells or (
            not DATE_RE.search(context_text) and not ROOM_RE.search(context_text)
        ):
            continue
        title_element = cells[0].find("strong")
        organizer_element = cells[0].find("i")
        title = clean(
            title_element.get_text(" ", strip=True)
            if title_element
            else cells[0].get_text(" ", strip=True)
        )
        organizers = (
            clean(organizer_element.get_text(" ", strip=True))
            if organizer_element
            else (clean(cells[1].get_text(" ", strip=True)) if len(cells) > 2 else None)
        )
        website = next(
            (
                a["href"].strip()
                for a in row.find_all("a", href=True)
                if a["href"].startswith("http")
                and is_external_project(a["href"], listing_host)
            ),
            None,
        )
        record = event_record(
            title, website, context_text, event_type, year, organizers
        )
        if record:
            table_entries.append(record)
    if table_entries:
        return table_entries

    entries, seen = [], set()
    for anchor in soup.find_all("a", href=True):
        href = anchor["href"].strip()
        if not href.startswith("http") or not is_external_project(href, listing_host):
            continue
        context = (
            anchor.find_parent(["article", "li", "div", "section"]) or anchor.parent
        )
        context_text = clean(context.get_text(" ", strip=True) if context else "")
        title = clean(anchor.get_text(" ", strip=True))
        if title.lower().replace("↗", "").strip() in {
            "project page",
            "website",
            "details",
            "more",
        }:
            title = context_text
        record = event_record(title, href, context_text, event_type, year)
        if not record:
            continue
        key = (record["title"].casefold(), href.rstrip("/"))
        if key not in seen:
            seen.add(key)
            entries.append(record)
    return entries


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--conference", required=True)
    parser.add_argument("--venue", default=None)
    parser.add_argument("--timezone", default=None)
    parser.add_argument("--year", required=True, type=int)
    parser.add_argument("--workshops-url")
    parser.add_argument("--tutorials-url")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.workshops_url and not args.tutorials_url:
        parser.error("supply at least one listing URL")

    workshops = (
        listing_entries(args.workshops_url, "Workshop", args.year)
        if args.workshops_url
        else []
    )
    tutorials = (
        listing_entries(args.tutorials_url, "Tutorial", args.year)
        if args.tutorials_url
        else []
    )
    dates = sorted(
        {event["date"] for event in workshops + tutorials if event.get("date")}
    )
    output = {
        "conference": args.conference,
        "venue": args.venue,
        "workshop_days": dates,
        "note": f"Times as listed by the official source ({args.timezone})"
        if args.timezone
        else None,
        "source_urls": {
            "workshops": args.workshops_url,
            "tutorials": args.tutorials_url,
        },
        "generated_at": datetime.now().astimezone().isoformat(),
        "total_workshops": len(workshops),
        "total_tutorials": len(tutorials),
        "workshops": workshops,
        "tutorials": tutorials,
    }
    args.output.write_text(
        json.dumps(output, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(
        f"Saved {len(workshops)} workshops and {len(tutorials)} tutorials → {args.output}"
    )


if __name__ == "__main__":
    main()
