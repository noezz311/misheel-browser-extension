"""Generate selectable and raster-only PDFs for actual browser integration."""
from pathlib import Path
from io import BytesIO
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader

HERE = Path(__file__).resolve().parent
FONT = Path("C:/Windows/Fonts/malgun.ttf")
if not FONT.exists():
    raise SystemExit("Set up a Korean TTF font and update FONT before regenerating fixtures.")
pdfmetrics.registerFont(TTFont("TestKorean", str(FONT)))

target = HERE / "korean-selectable.pdf"
pdf = canvas.Canvas(str(target), pagesize=(612, 792), pageCompression=1)
pdf.setTitle("Korean text selection integration fixture")
for page, (word, sentence) in enumerate([
    ("학교", "저는 학교에 갑니다."),
    ("사과", "사과와 바다를 배웁니다."),
], 1):
    pdf.setFillColorRGB(.12, .2, .32)
    pdf.setFont("Helvetica", 15)
    pdf.drawString(52, 732, "MISHEEL - Korean selection sample")
    pdf.setFillColorRGB(.15, .43, .34)
    pdf.setFont("TestKorean", 35)
    pdf.drawString(52, 646, word)
    pdf.setFillColorRGB(.18, .23, .29)
    pdf.setFont("TestKorean", 20)
    pdf.drawString(52, 588, sentence)
    pdf.setFont("Helvetica", 12)
    pdf.drawString(52, 536, "Select the Korean word to display its Mongolian dictionary meaning.")
    pdf.setFillColorRGB(.45, .49, .56)
    pdf.setFont("Helvetica", 10)
    pdf.drawString(52, 40, f"Page {page} of 2 - local, embedded Korean font")
    pdf.showPage()
pdf.save()
reader = PdfReader(target)
assert len(reader.pages) == 2
assert "학교" in reader.pages[0].extract_text()
assert "사과" in reader.pages[1].extract_text()

image = Image.new("RGB", (1224, 1584), "white")
draw = ImageDraw.Draw(image)
draw.text((104, 132), "학교", font=ImageFont.truetype(str(FONT), 86), fill=(30, 59, 82))
draw.text((104, 290), "스캔된 이미지에는 선택 가능한 글자가 없습니다.",
          font=ImageFont.truetype(str(FONT), 32), fill=(71, 90, 107))
png = BytesIO()
image.save(png, format="PNG")
scan_target = HERE / "korean-scanned.pdf"
pdf = canvas.Canvas(str(scan_target), pagesize=(612, 792), pageCompression=1)
pdf.setTitle("Raster-only Korean integration fixture")
pdf.drawImage(ImageReader(png), 0, 0, width=612, height=792)
pdf.save()
assert not (PdfReader(scan_target).pages[0].extract_text() or "").strip()
(HERE / "invalid.pdf").write_bytes(b"This is not a PDF document.\n")
print(f"Generated and verified Korean text extraction: {target.name}")
print(f"Generated raster-only {scan_target.name}, no extractable text")
