"""生成分享预览图 public/og-image.png（1200x630）。

为什么用 Python 而不是 SVG：微信、QQ、Twitter 的预览卡片普遍不解析 SVG，
只认位图。留下一份生成脚本而不是一堆二进制，是为了这张图以后可以重做
（改文案、换配色），而不是变成没人敢动的不透明资产。

用法：
    python scripts/gen-og-image.py
"""

from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
BG = (11, 18, 32)
BG_SOFT = (16, 26, 44)
BRAND = (56, 224, 200)
BRAND_DIM = (20, 167, 149)
TEXT = (230, 236, 247)
MUTED = (139, 156, 186)

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "og-image.png")

FONT_CANDIDATES = [
    (r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\msyh.ttc"),
    (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\msyh.ttc"),
    (r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\simsun.ttc"),
]


def pick_fonts() -> tuple[str, str]:
    for bold, regular in FONT_CANDIDATES:
        if os.path.exists(bold) and os.path.exists(regular):
            return bold, regular
    raise SystemExit("找不到可用的中文字体，请手动指定 FONT_CANDIDATES")


def main() -> None:
    bold_path, regular_path = pick_fonts()
    title_font = ImageFont.truetype(bold_path, 84)
    sub_font = ImageFont.truetype(regular_path, 36)
    chip_font = ImageFont.truetype(regular_path, 28)
    foot_font = ImageFont.truetype(regular_path, 26)

    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    # 顶部一层柔和的品牌色辉光，避免纯平底色显得廉价
    glow = Image.new("RGB", (W, H), BG)
    gdraw = ImageDraw.Draw(glow)
    for i in range(160, 0, -1):
        t = i / 160
        radius = int(i * 7)
        color = tuple(int(BG[c] + (BRAND_DIM[c] - BG[c]) * (1 - t) * 0.55) for c in range(3))
        gdraw.ellipse(
            [W // 2 - radius, -radius + 40, W // 2 + radius, radius + 40],
            fill=color,
        )
    img = Image.blend(img, glow, 0.55)
    draw = ImageDraw.Draw(img)

    # 左侧品牌竖条
    draw.rounded_rectangle([72, 96, 82, 232], radius=5, fill=BRAND)

    draw.text((112, 96), "SimulNote", font=title_font, fill=TEXT)
    draw.text((114, 196), "同传笔记", font=sub_font, fill=BRAND)

    draw.text((112, 300), "英文讲话 → 实时中文翻译", font=sub_font, fill=TEXT)
    draw.text((112, 356), "讲完自动生成中文要点纪要", font=sub_font, fill=TEXT)

    chips = [("零安装", 112), ("零费用", 264), ("音频不出设备", 416)]
    for label, x in chips:
        bbox = draw.textbbox((0, 0), label, font=chip_font)
        w = bbox[2] - bbox[0] + 52
        draw.rounded_rectangle([x, 452, x + w, 512], radius=30, outline=(46, 66, 102), width=2)
        draw.text((x + 26, 462), label, font=chip_font, fill=MUTED)

    draw.text(
        (112, 556),
        "在浏览器里运行 · 手机可用 · 打开链接就能用",
        font=foot_font,
        fill=(90, 108, 140),
    )

    # 右下角装饰性声波
    base_x, base_y = 900, 330
    heights = [26, 52, 84, 120, 150, 120, 84, 52, 26]
    for i, h in enumerate(heights):
        x = base_x + i * 26
        draw.rounded_rectangle(
            [x, base_y - h // 2, x + 12, base_y + h // 2],
            radius=6,
            fill=BRAND if i % 2 == 0 else BRAND_DIM,
        )

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.save(OUT, "PNG", optimize=True)
    print(f"已生成 {OUT} ({os.path.getsize(OUT)} 字节)")


if __name__ == "__main__":
    main()
