"""Make white background transparent in a PNG. One-off script for logo."""
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("Pillow required: pip install Pillow")
    sys.exit(1)

def remove_white_bg(src: str, dst: str, threshold: int = 250) -> None:
    img = Image.open(src).convert("RGBA")
    data = img.getdata()
    new_data = []
    for item in data:
        r, g, b, a = item
        if r >= threshold and g >= threshold and b >= threshold:
            new_data.append((255, 255, 255, 0))
        else:
            new_data.append(item)
    img.putdata(new_data)
    img.save(dst, "PNG")
    print("Saved:", dst)

if __name__ == "__main__":
    src = sys.argv[1]
    dst = sys.argv[2]
    threshold = int(sys.argv[3]) if len(sys.argv) > 3 else 250
    remove_white_bg(src, dst, threshold)
