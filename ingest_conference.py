#!/usr/bin/env python3
"""Interactive entry point for adding a conference to Workshop Radar."""

import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
TEMPLATES = {
    "1": {"id": "eccv2026", "name": "ECCV 2026", "year": 2026, "venue": "Malmö, Sweden", "timezone": "Europe/Stockholm", "workshops": "https://eccv.ecva.net/Conferences/2026/Workshops", "tutorials": "https://eccv.ecva.net/Conferences/2026/Tutorials"},
    "2": {"id": "cvpr2026", "name": "CVPR 2026", "year": 2026, "venue": "Denver Convention Center, Denver, Colorado, USA", "timezone": "America/Denver", "workshops": "https://cvpr.thecvf.com/Conferences/2026/Workshops", "tutorials": "https://cvpr.thecvf.com/Conferences/2026/Tutorials"},
}


def ask(label: str, default: str = "", required: bool = False) -> str:
    prompt = f"{label}{f' [{default}]' if default else ''}: "
    while True:
        value = input(prompt).strip() or default
        if value or not required:
            return value
        print("A value is required.")


def yes_no(label: str, default: bool = False) -> bool:
    suffix = "Y/n" if default else "y/N"
    return ask(f"{label} ({suffix})").lower() in ({"", "y", "yes"} if default else {"y", "yes"})


def main() -> None:
    argparse.ArgumentParser(description=__doc__).parse_args()
    print("Workshop Radar conference ingestion\n  1. ECCV 2026 (web listings)\n  2. CVPR 2026 (PDF or web listings)\n  3. New conference")
    choice = ask("Choose a conference", "1", required=True)
    template = dict(TEMPLATES.get(choice, {}))
    if not template:
        template = {"id": ask("Conference id (for example iccv2027)", required=True), "name": ask("Conference name", required=True), "year": int(ask("Year", required=True)), "venue": ask("Venue"), "timezone": ask("Timezone (IANA name)")}
    conference_id = ask("Conference id", template.get("id", ""), required=True)
    name = ask("Conference name", template.get("name", ""), required=True)
    year = int(ask("Conference year", str(template.get("year", "")), required=True))
    venue = ask("Venue", template.get("venue", ""))
    timezone = ask("Timezone", template.get("timezone", ""))
    workshops_url = ask("Workshop listing URL", template.get("workshops", ""))
    tutorials_url = ask("Tutorial listing URL", template.get("tutorials", ""))
    pdf_path = ask("Official programme PDF (optional)")
    output = HERE / "conferences" / conference_id / "data" / "workshops_tutorials.json"
    output.parent.mkdir(parents=True, exist_ok=True)

    if pdf_path:
        command = [sys.executable, str(HERE / "conferences" / "cvpr2026" / "scripts" / "extract.py"), "--pdf", pdf_path, "--output", str(output)]
    else:
        if not workshops_url and not tutorials_url:
            raise SystemExit("Provide at least one listing URL or a programme PDF.")
        command = [sys.executable, str(HERE / "extract_web_listing.py"), "--conference", name, "--year", str(year), "--output", str(output)]
        if venue: command += ["--venue", venue]
        if timezone: command += ["--timezone", timezone]
        if workshops_url: command += ["--workshops-url", workshops_url]
        if tutorials_url: command += ["--tutorials-url", tutorials_url]
    subprocess.run(command, check=True)

    data = json.loads(output.read_text(encoding="utf-8"))
    print(f"\nInitial list validated: {data['total_workshops']} workshops, {data['total_tutorials']} tutorials.")
    map_pdfs = ask("Venue-map PDF paths, comma-separated (optional)")
    if map_pdfs:
        subprocess.run([sys.executable, str(HERE / "build_map_assets.py"), "--conference", conference_id, "--events", str(output), "--maps", *[item.strip() for item in map_pdfs.split(',') if item.strip()]], check=True)
    if yes_no("Run Ollama programme extraction now?", False):
        subprocess.run([sys.executable, str(HERE / "ollama_extract.py"), "--input", str(output)], check=True)
    print(f"\nDone. Generated data is at {output.name}. Review it before setting the conference to live in conferences.json.")


if __name__ == "__main__":
    main()
