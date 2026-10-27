#!/usr/bin/env python3
"""Check cross-file Windows identity and packaged brand assets.

Use --check-midl after SDK regeneration to verify checked-in COM outputs.
"""
from pathlib import Path
import argparse
import json
import re
import uuid
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]


def parse_guid(text):
    n = [int(x, 16) for x in re.findall(r'0x([0-9a-fA-F]+)', text)]
    assert len(n) == 11, text
    return uuid.UUID(fields=(n[0], n[1], n[2], n[3], n[4],
                             int.from_bytes(bytes(n[5:]), 'big')))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check-midl', action='store_true')
    args = ap.parse_args()
    header = (ROOT/'chromium_src/chrome/install_static/chromium_install_modes.h').read_text()
    regular = header.split('#else   // !BUILDFLAG(IS_BRAVE_ORIGIN_BRANDED)')[1]
    idl = (ROOT/'chromium_src/chrome/elevation_service/elevation_service_idl.idl').read_text()
    iid_set = {uuid.UUID(x) for x in re.findall(r'uuid\(([^)]+)\)', idl)}
    elevator_iids = [parse_guid(x) for x in re.findall(r'\.elevator_iid = (\{.*?\}\})', regular, re.S)]
    assert len(elevator_iids) == 5
    assert set(elevator_iids) <= iid_set, 'Install modes and COM IDL differ'
    for prefix in re.findall(r'\.(?:browser|pdf)_prog_id_prefix = L"([^"]+)"', regular):
        assert len(prefix) <= 11 and prefix.isalnum(), prefix
    assert 'L"Velmren"' in header and 'L"Velmren-Browser-Development"' in header
    for value in re.findall(r'\.direct_launch_url_scheme = "([^"]+)"', regular):
        assert value.startswith('velmren-browser')
    values = json.loads((ROOT/'app/theme/velmren/windows_identity.json').read_text())['guid_replacements']
    assert len(set(values.values())) == len(values)
    for old in values:
        assert old not in regular.upper(), f'Inherited GUID remains: {old}'
    for rel in ['chromium_src/chrome/common/chrome_constants.cc',
                'chromium_src/chrome/installer/util/util_constants.h',
                'build/win/BUILD.gn', 'app/brave_exe.ver',
                'patches/chrome-installer-mini_installer-chrome.release.patch',
                'patches/chrome-chrome_proxy-chrome_proxy_main_win.cc.patch']:
        text = (ROOT/rel).read_text()
        assert 'velmren.exe' in text and '"brave.exe"' not in text, rel
    required = {(n,n) for n in (16,20,24,32,40,48,64,128,256)}
    for icon in (ROOT/'app/theme/brave/win').glob('*.ico'):
        with Image.open(icon) as im:
            assert required == im.ico.sizes(), icon
            for size in required:
                decoded = im.ico.getimage(size)
                assert decoded.mode == 'RGBA' and decoded.getbbox(), (icon,size)
    for path in (ROOT/'app/theme/brave').glob('BRANDING*'):
        text = path.read_text()
        assert 'PRODUCT_FULLNAME=Velmren Browser' in text
        assert 'COPYRIGHT=Copyright 2016 The Brave Authors.' in text
    if args.check_midl:
        for arch in ['x64', 'x86', 'arm64', '']:
            out = ROOT/'win_build_output/midl/chrome/elevation_service'/arch
            generated = (out/'elevation_service_idl_i.c').read_text()
            generated_guids = {parse_guid(x) for x in re.findall(r'MIDL_DEFINE_GUID\([^;]+;', generated) if '0x' in x}
            assert iid_set <= generated_guids, f'Regenerate MIDL for {arch or "default"}'
            assert (out/'elevation_service_idl.tlb').stat().st_size > 0
    print('Windows identity, source COM IIDs, executable packaging and 14 ICO assets: PASS')
    if not args.check_midl:
        print('MIDL generated output check not requested; required before Windows build.')


if __name__ == '__main__':
    main()
