"""Generate the PNG app icons. Geometric, so they stay sharp at any size."""
import math
import pathlib

from PIL import Image, ImageDraw

OUT = pathlib.Path(r"C:\Users\JenilAgrawal\Documents\New folder\articleSaver\frontend\icons")
INK = (20, 17, 15, 255)
PAPER = (250, 249, 247, 255)
SS = 4  # supersample factor for smooth edges


def rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def leaning_book(draw, cx, cy, w, h, angle_deg, fill, radius=6):
    """A book leaning against the others, drawn as a rotated rounded rectangle."""
    a = math.radians(angle_deg)
    cos_a, sin_a = math.cos(a), math.sin(a)
    pts = []
    for dx, dy in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)):
        pts.append((cx + dx * cos_a - dy * sin_a, cy + dx * sin_a + dy * cos_a))
    draw.polygon(pts, fill=fill)
    void = radius


def draw_mark(draw, scale, offset=(0, 0)):
    # The leaning volume widens the group to the right, so the whole mark shifts
    # left of centre unless it is nudged back.
    ox, oy = offset[0] + 17 * scale, offset[1]

    def S(v):
        return v * scale

    # Two upright volumes.
    rounded(draw, [ox + S(146), oy + S(150), ox + S(190), oy + S(362)], S(7), PAPER)
    rounded(draw, [ox + S(206), oy + S(150), ox + S(250), oy + S(362)], S(7), PAPER)
    # One leaning against them.
    leaning_book(draw, ox + S(292), oy + S(262), S(44), S(212), 10, PAPER)


def build(size, maskable=False):
    canvas = size * SS
    img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if maskable:
        # Full bleed: Android crops maskable icons to its own shape.
        d.rectangle([0, 0, canvas, canvas], fill=INK)
        inner = 0.72                     # keep the mark inside the safe zone
        scale = (canvas / 512) * inner
        pad = (canvas - 512 * scale) / 2
        draw_mark(d, scale, (pad, pad))
    else:
        radius = int(canvas * 112 / 512)
        d.rounded_rectangle([0, 0, canvas - 1, canvas - 1], radius=radius, fill=INK)
        draw_mark(d, canvas / 512)

    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
build(192).save(OUT / "icon-192.png")
build(512).save(OUT / "icon-512.png")
build(512, maskable=True).save(OUT / "icon-maskable.png")
build(180).save(OUT / "apple-touch-icon.png")
print("wrote:", sorted(p.name for p in OUT.glob("*.png")))
