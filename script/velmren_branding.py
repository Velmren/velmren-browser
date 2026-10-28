"""Brand browser UI after translation so existing XTB fingerprints remain valid."""
import re

# These names identify upstream people or real external products, not this app.
_EXTERNAL = r'Authors|Software|Search|VPN|Talk|Rewards|Wallet|News|Leo|Premium|Origin'
_BROWSER_NAME = re.compile(r'\bBrave(?: Browser)?\b(?! (?:' + _EXTERNAL + r')\b)')
_UI_SCHEME = re.compile(r'\bbrave://', re.IGNORECASE)
_LEGAL_IDS = ('COPYRIGHT', 'TERMS_OF_SERVICE', 'TERMS_OF_USE', 'PRIVACY_POLICY',
              'ADDITIONAL_TERMS', 'LICENSE')


def brand_ui_text(name, text):
    """Keep attribution and external URLs while branding browser UI text."""
    if name == 'IDS_SEARCH_ENGINES_STARTER_PACK_ASK_BRAVE_SEARCH_NAME':
        return 'Brave Search'
    if (any(part in name for part in _LEGAL_IDS)
            or ('IMPORT' in name and 'BRAVE' in name)
            or any(part in name for part in ('P3A', 'USAGE_PING'))):
        return text
    if name == 'IDS_PRODUCT_NAME':
        return 'Velmren Browser'
    if name == 'IDS_SHORT_PRODUCT_NAME':
        return 'Velmren'
    return _BROWSER_NAME.sub('Velmren', _UI_SCHEME.sub('velmren://', text))
