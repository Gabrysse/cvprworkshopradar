# CVPR 2026 conference files

- `data/workshops_tutorials.json` is the archived programme used by the site.
- `data/debug_pdf_extract.json` records PDF-extraction comparisons.
- `source/` contains the official programme and venue-map PDFs.
- `maps/images/` contains generated floor-plan PNGs; `maps/room_coords.json` maps event rooms to those images.
- `scripts/` holds the CVPR-only PDF extraction, PDF enrichment, legacy scraper, and map generator.

The root `conferences.json` registers these paths for the archive. Shared tools such as `ingest_conference.py`, `extract_web_listing.py`, and `ollama_extract.py` remain at the repository root.
