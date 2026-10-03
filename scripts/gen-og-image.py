"""生成站点图标与分享预览图。

产出三个文件：
    public/og-image.png          1200x630  微信 / QQ / Telegram / Twitter 的预览卡片
    public/apple-touch-icon.png   180x180  iOS「添加到主屏幕」用的图标
    public/pwa-icon-512.png       512x512  Android 安装提示 / PWA manifest

为什么用 Python 而不是 SVG：微信、QQ、Twitter 的预览卡片、以及 iOS 的
apple-touch-icon **都不接受 SVG**，只认位图。留下一份生成脚本而不是一堆二进制，
是为了这些图以后可以重做（改文案、换配色），而不是变成没人敢动的不透明资产。

注意 apple-touch-icon 必须是**不透明的整块方形**：iOS 会自己套圆角蒙版，
图里自带圆角或透明边会露出黑角。

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

PUBLIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")
OUT = os.path.join(PUBLIC, "og-image.png")
OUT_TOUCH = os.path.join(PUBLIC, "apple-touch-icon.png")
OUT_PWA = os.path.join(PUBLIC, "pwa-icon-512.png")

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


def make_icon(size: int) -> Image.Image:
    """整块方形、不透明的应用图标：深底 + 居中品牌声波。

    刻意不做圆角、不加透明通道 —— iOS / Android 各自会套自己的蒙版。
    """
    img = Image.new("RGB", (size, size), BG)

    # 从中心往外扩散的辉光，让纯色底不那么死
    glow = Image.new("RGB", (size, size), BG)
    gdraw = ImageDraw.Draw(glow)
    for i in range(120, 0, -1):
        t = i / 120
        radius = int(t * size * 0.72)
        color = tuple(int(BG[c] + (BRAND_DIM[c] - BG[c]) * (1 - t) * 0.7) for c in range(3))
        cx = cy = size // 2
        gdraw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=color)
    img = Image.blend(img, glow, 0.5)

    draw = ImageDraw.Draw(img)

    # 声波：中间高、两侧递减，偶数位用亮色做出节奏感。
    # 刻意留出约 13% 的边距 —— iOS 会套一个圆角蒙版，贴边的图形会被切掉。
    heights = [0.30, 0.55, 0.80, 1.0, 0.80, 0.55, 0.30]
    bar_w = size * 0.062
    gap = size * 0.052
    step = bar_w + gap
    total = step * len(heights) - gap
    x = (size - total) / 2
    cy = size / 2
    max_h = size * 0.46
    for i, ratio in enumerate(heights):
        h = max_h * ratio
        draw.rounded_rectangle(
            [x, cy - h / 2, x + bar_w, cy + h / 2],
            radius=bar_w / 2,
            fill=BRAND if i % 2 == 0 else BRAND_DIM,
        )
        x += step

    return img


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

    os.makedirs(PUBLIC, exist_ok=True)
    img.save(OUT, "PNG", optimize=True)
    print(f"已生成 {OUT} ({os.path.getsize(OUT)} 字节)")

    touch = make_icon(180)
    touch.save(OUT_TOUCH, "PNG", optimize=True)
    print(f"已生成 {OUT_TOUCH} ({os.path.getsize(OUT_TOUCH)} 字节)")

    pwa = make_icon(512)
    pwa.save(OUT_PWA, "PNG", optimize=True)
    print(f"已生成 {OUT_PWA} ({os.path.getsize(OUT_PWA)} 字节)")


if __name__ == "__main__":
    main()
