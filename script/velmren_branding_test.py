"""Checks that branding cannot relabel legal notices or external services."""
import unittest
from velmren_branding import brand_ui_text


class VelmrenBrandingTest(unittest.TestCase):
    def test_browser_names_and_translations(self):
        self.assertEqual(brand_ui_text('IDS_PRODUCT_NAME', 'Brave'), 'Velmren Browser')
        self.assertEqual(brand_ui_text('IDS_SHORT_PRODUCT_NAME', 'Brave'), 'Velmren')
        self.assertEqual(brand_ui_text('IDS_ABOUT', 'О браузере Brave'), 'О браузере Velmren')
        self.assertEqual(brand_ui_text('IDS_WELCOME', 'Welcome to Brave Browser'), 'Welcome to Velmren')

    def test_legal_attribution_is_preserved(self):
        for name in ['IDS_COPYRIGHT', 'IDS_TERMS_OF_SERVICE', 'IDS_LICENSE', 'IDS_PRIVACY_POLICY']:
            self.assertEqual(brand_ui_text(name, 'Brave Browser'), 'Brave Browser')
        self.assertEqual(brand_ui_text('IDS_NOTICE', 'The Brave Authors / Brave Software, Inc.'), 'The Brave Authors / Brave Software, Inc.')

    def test_external_services_and_urls_remain_accurate(self):
        text = 'Use Brave Search in Brave. https://brave.com/ $1'
        self.assertEqual(brand_ui_text('IDS_SEARCH', text), 'Use Brave Search in Velmren. https://brave.com/ $1')
        self.assertEqual(brand_ui_text('IDS_IMPORT', 'Bravery and brave'), 'Bravery and brave')

    def test_internal_url_labels_use_canonical_scheme(self):
        self.assertEqual(
            brand_ui_text('IDS_PERMISSIONS_BUBBLE_SETTINGS_EXTENSIONS_LINK',
                          'brave://settings/extensions'),
            'velmren://settings/extensions')
        self.assertEqual(
            brand_ui_text('IDS_SETTINGS_LEO_ASSISTANT_PRIVATE_IP_NOT_ALLOWED_INSTRUCTIONS',
                          'Откройте BRAVE://flags/#brave-ai-chat-allow-private-ips. $1'),
            'Откройте velmren://flags/#brave-ai-chat-allow-private-ips. $1')
        self.assertEqual(brand_ui_text('IDS_SETTINGS_LINK', 'Brave://settings/'),
                         'velmren://settings/')
        self.assertEqual(
            brand_ui_text('IDS_HELP', 'Brave Search: https://search.brave.com/; chrome-extension://id'),
            'Brave Search: https://search.brave.com/; chrome-extension://id')

    def test_attribution_exemptions_preserve_internal_url_text(self):
        for name in ['IDS_LICENSE', 'IDS_IMPORT_BRAVE', 'IDS_P3A_NOTICE']:
            with self.subTest(name=name):
                text = 'Brave: brave://settings/'
                self.assertEqual(brand_ui_text(name, text), text)


if __name__ == '__main__':
    unittest.main()
