"""Generate extension icons locally; no image-generation service is required."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1]
target = root / "extension" / "icons"
target.mkdir(parents=True, exist_ok=True)
font_path = Path("C:/Windows/Fonts/malgunbd.ttf")
canvas = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
draw = ImageDraw.Draw(canvas)
draw.rounded_rectangle((0, 0, 511, 511), radius=132, fill="#4265e8")
font = ImageFont.truetype(str(font_path), 340)
draw.text((256, 239), "한", fill="white", font=font, anchor="mm")
for size in (16, 32, 48, 128):
    canvas.resize((size, size), Image.Resampling.LANCZOS).save(target / f"{size}.png")
print("Generated 16, 32, 48 and 128px icons.")
