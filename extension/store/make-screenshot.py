# python3 store/make-screenshot.py: store/screenshot-1280x800.png from the background
# (screenshot-background.svg, via rsvg-convert) and a side panel capture (panel.png).
import subprocess
from PIL import Image, ImageDraw

subprocess.run(['rsvg-convert', '-w', '1280', '-h', '800', 'store/screenshot-background.svg', '-o', '/tmp/screenshot-background.png'], check=True)
bg = Image.open('/tmp/screenshot-background.png').convert('RGB')
shot = Image.open('store/panel.png').convert('RGB')
w = 401
h = min(720, round(shot.height * w / shot.width))
s = shot.resize((w, round(shot.height * w / shot.width)), Image.LANCZOS).crop((0, 0, w, h))
mask = Image.new('L', (w * 4, h * 4), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, w * 4 - 1, h * 4 - 1), radius=64, fill=255)
bg.paste(s, (820, (800 - h) // 2), mask.resize((w, h), Image.LANCZOS))
bg.save('store/screenshot-1280x800.png')
