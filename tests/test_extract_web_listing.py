import unittest
from unittest.mock import patch

import extract_web_listing


class WebListingExtractionTests(unittest.TestCase):
    def test_reads_generic_project_page_row(self):
        html = '''<table><tr><td>Future Vision Workshop
          <a href="https://events.example.org">Project Page</a>
          Alice Example · In Room: Hall A Sep 8</td></tr></table>'''

        class Response:
            text = html
            url = "https://conference.example/list"

            def raise_for_status(self):
                return None

        with patch.object(extract_web_listing.requests, "get", return_value=Response()):
            entries = extract_web_listing.listing_entries(
                "https://conference.example/list", "Workshop", 2026
            )

        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["title"], "Future Vision Workshop")
        self.assertEqual(entries[0]["date"], "2026-09-08")
        self.assertEqual(entries[0]["location"], "Hall A")
        self.assertEqual(entries[0]["website"], "https://events.example.org")

    def test_ignores_global_links_without_event_metadata(self):
        html = '<footer><a href="https://publisher.example/code">Code of Conduct</a></footer>'

        class Response:
            text = html
            url = "https://conference.example/list"

            def raise_for_status(self):
                return None

        with patch.object(extract_web_listing.requests, "get", return_value=Response()):
            self.assertEqual(extract_web_listing.listing_entries("https://conference.example/list", "Workshop", 2026), [])

    def test_reads_eccv_style_tutorial_row_without_project_page(self):
        html = '''<table><tr><td><strong>Preference Alignment Tutorial</strong><div><i>Jane Doe</i></div></td>
          <td class="elc-keywords">Tutorials</td><td>In Room: Room B Sep 9, PM</td></tr></table>'''

        class Response:
            text = html
            url = "https://conference.example/list"

            def raise_for_status(self):
                return None

        with patch.object(extract_web_listing.requests, "get", return_value=Response()):
            entries = extract_web_listing.listing_entries("https://conference.example/list", "Tutorial", 2026)

        self.assertEqual(entries[0]["title"], "Preference Alignment Tutorial")
        self.assertEqual(entries[0]["organizers"], "Jane Doe")
        self.assertEqual(entries[0]["time_slot"], "PM")
        self.assertIsNone(entries[0]["website"])


if __name__ == "__main__":
    unittest.main()
