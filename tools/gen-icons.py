#!/usr/bin/env python3
"""生成 App 图标全套资源：mipmap 各密度 ic_launcher/round/fg + 聊天页 logo.svg。
设计：紫蓝渐变圆角方底 + 白色对话气泡 + 气泡内双向进化箭头（与 Web 页 SVG 同款）。
用法：python3 tools/gen-icons.py  （需 Pillow；产物直接落 android/app/src/main/res/）"""
import math
import os

from PIL import Image, ImageDraw

RES = os.path.join(os.path.dirname(__file__), "..", "android", "app", "src", "main", "res")

# 密度 → launcher 图标边长（dp 48 标准）
DENS = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient_bg(size, c1=(99, 102, 241), c2=(139, 92, 246)):
    """对角线性渐变（左上 → 右下）"""
    img = Image.new("RGBA", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size - 2)
            px[x, y] = lerp(c1, c2, t) + (255,)
    return img


def rounded_mask(size, radius_ratio=0.225):
    """启动器圆角方形遮罩（自适应图标背景规范 ~ round rect）"""
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255)
    return m


def bubble(size, color=(255, 255, 255)):
    """白色对话气泡 + 双向箭头（Web 页 SVG 的位图版，矢量描点同比例映射）"""
    S = size * 10  # 超采样抗锯齿
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def P(x, y):  # SVG viewBox 40 坐标映射
        return (x * S / 40, y * S / 40)

    # 气泡（圆角矩形 + 左下尾巴，描点近似 SVG path）
    bx0, by0, bx1, by1 = P(9.5, 9.5)[0], P(9.5, 9.5)[1], P(30.5, 26.3)[0], P(30.5, 26.3)[1]
    r = (bx1 - bx0) * 0.32
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=r, fill=color + (255,))
    # 尾巴：三角（左下）
    d.polygon([P(13.3, 24.4), P(11.0, 28.7), P(17.5, 26.2)], fill=color + (255,))

    # 双向箭头：上排 → 右向，下排 ← 左向（气泡内居中）
    w = max(2, int(S * 0.043))  # 线宽 ~1.7/40
    y_up, y_dn = 18.4, 21.6
    x0, x1 = 15.6, 24.4
    ah = 2.6  # 箭头半高
    for yy, x_start, x_end, in_ in ((y_up, x0, x1, True), (y_dn, x1, x0, False)):
        d.line([P(x_start, yy), P(x_end, yy)], fill=(99, 102, 241, 255), width=w)
        tip = x_end
        base = x_end - (x1 - x0) * 0.29 if in_ else x_end + (x1 - x0) * 0.29
        d.polygon([P(tip, yy), P(base, yy - ah), P(base, yy + ah)], fill=(99, 102, 241, 255))
    return img.resize((size, size), Image.LANCZOS)


def compose_launcher(size):
    """普通方形图标：渐变底 + 气泡前景"""
    img = gradient_bg(size)
    mask = rounded_mask(size)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    fg = bubble(size)
    out.alpha_composite(fg)
    return out


def compose_round(size):
    """圆形图标"""
    img = gradient_bg(size)
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.ellipse([0, 0, size - 1, size - 1], fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), m)
    out.alpha_composite(bubble(size))
    return out


def compose_fg(size):
    """自适应图标前景：透明底 + 气泡居中缩到 safe zone（66/108 ≈ 61%）"""
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = int(size * 0.58)
    fg = bubble(inner)
    out.alpha_composite(fg, ((size - inner) // 2, (size - inner) // 2))
    return out


def main():
    for dpi, size in DENS.items():
        d = os.path.join(RES, "mipmap-" + dpi)
        os.makedirs(d, exist_ok=True)
        compose_launcher(size).save(os.path.join(d, "ic_launcher.png"))
        compose_round(size).save(os.path.join(d, "ic_launcher_round.png"))
        compose_fg(size).save(os.path.join(d, "ic_launcher_fg.png"))
        print(f"mipmap-{dpi}: {size}px x3")
    print("图标生成完成")


if __name__ == "__main__":
    main()
