#!/usr/bin/env python3
"""Generate Velmren's original Windows/UI assets. Requires Pillow.

Run from any directory. The checked-in SVG is the editable design source;
Pillow renders the same simple geometry at 4x resolution for crisp small icons.
"""
from pathlib import Path
import argparse
import shutil
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
DARK = '#092C35'
TEAL = '#40D9BC'
LIGHT = '#D4FFF3'
LEFT = [(51, 55), (93, 55), (144, 190), (113, 211)]
RIGHT = [(163, 55), (205, 55), (144, 211), (113, 211)]
SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><title>Velmren Browser</title><rect x="8" y="8" width="240" height="240" rx="58" fill="#092C35"/><path d="M51 55H93L144 190L113 211Z" fill="#D4FFF3"/><path d="M163 55H205L144 211H113Z" fill="#40D9BC"/></svg>\n'''


def mark(size, mono=False):
    scale = size * 4 / 256
    im = Image.new('RGBA', (size * 4, size * 4))
    d = ImageDraw.Draw(im)
    if not mono:
        d.rounded_rectangle(tuple(round(v*scale) for v in (8,8,248,248)), radius=round(58*scale), fill=DARK)
    for points, color in ((LEFT, LIGHT), (RIGHT, TEAL)):
        d.polygon([(round(x*scale),round(y*scale)) for x,y in points], fill='white' if mono else color)
    return im.resize((size,size),Image.Resampling.LANCZOS)


def wordmark(size, font_path, white=False):
    w,h=size
    im=Image.new('RGBA',(w*4,h*4))
    icon=mark(h*4, mono=white)
    im.alpha_composite(icon,(0,0))
    d=ImageDraw.Draw(im)
    fs=int(h*4*.65)
    while fs>1:
        font=ImageFont.truetype(font_path,fs)
        if d.textlength('Velmren',font=font)<=w*4-h*4-h*.3*4: break
        fs-=1
    box=d.textbbox((0,0),'Velmren',font=font)
    d.text((int(h*4*1.2),(h*4-(box[3]-box[1]))//2-box[1]),'Velmren',font=font,fill='white' if white else DARK)
    return im.resize(size,Image.Resampling.LANCZOS)


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--font',default='C:/Windows/Fonts/segoeuib.ttf')
    args=ap.parse_args()
    (ROOT/'app/theme/velmren/logo.svg').write_text(SVG,newline='\n')
    for name in ['product_logo.svg','product_logo_animation.svg']:
        (ROOT/'app/theme/brave'/name).write_text(SVG,newline='\n')
    files=list((ROOT/'app/theme/brave').glob('product_logo*.png'))
    for scale in ['default_100_percent','default_200_percent']:
        files+=list((ROOT/'app/theme'/scale/'brave').glob('product_logo*.png'))
    files+=list((ROOT/'app/theme/brave/win/tiles').glob('*.png'))
    for path in files:
        with Image.open(path) as original: size=original.size
        if 'name' in path.name:
            im=wordmark(size,args.font,'white' in path.name)
        else:
            im=mark(min(size),'mono' in path.name or 'white' in path.name)
            if im.size!=size:
                canvas=Image.new('RGBA',size);canvas.alpha_composite(im,((size[0]-im.width)//2,(size[1]-im.height)//2));im=canvas
        im.save(path)
    # Preserve icon resource order and filenames; replace embedded bitmap art.
    for path in (ROOT/'app/theme/brave/win').glob('*.ico'):
        mark(256).save(path,format='ICO',sizes=[(s,s) for s in [16,20,24,32,40,48,64,128,256]])
    for scale in ['default_100_percent', 'default_200_percent']:
        shutil.copyfile(
            ROOT/'app/theme'/scale/'brave/product_logo_16.png',
            ROOT/'build/chromium/resources/chrome/app/theme'/scale/'common/favicon_ntp.png')
    mark(512).save(ROOT/'app/theme/velmren/logo-preview.png')
    print(f'Generated {len(files)} PNGs, Windows ICOs, and SVG source.')


if __name__=='__main__': main()
