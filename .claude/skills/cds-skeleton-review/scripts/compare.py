#!/usr/bin/env python3
"""Compose paired browser screenshots without stretching or cropping them."""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", choices=("desktop", "mobile"), required=True)
    parser.add_argument("--route", required=True)
    parser.add_argument("--skeleton", type=Path, required=True)
    parser.add_argument("--loaded", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    mobile = args.device == "mobile"
    expected = (390, 844) if mobile else (1920, 1080)
    with Image.open(args.skeleton) as skeleton, Image.open(args.loaded) as loaded:
        if skeleton.size != expected or loaded.size != expected:
            parser.error(f"{args.device} 两张源图必须为 {expected[0]}×{expected[1]}，当前为 {skeleton.size} 和 {loaded.size}")
        canvas = Image.new("RGB", (804, 916) if mobile else (1920, 1080), "#f0ece7")
        draw = ImageDraw.Draw(canvas)
        font = ImageFont.load_default(size=18 if mobile else 28)
        draw.text((12 if mobile else 24, 14 if mobile else 32), args.route, font=font, fill="#25221f")
        positions = ((6, 64), (408, 64)) if mobile else ((20, 247), (970, 247))
        for source, (x, y), label in zip((skeleton, loaded), positions, ("Skeleton", "Loaded")):
            draw.text((x, y - (24 if mobile else 42)), label, font=font, fill="#25221f")
            image = source.convert("RGB")
            if not mobile:
                image.thumbnail((930, 1080), Image.Resampling.LANCZOS)
            canvas.paste(image, (x, y))
        canvas.save(args.out, optimize=True)


if __name__ == "__main__":
    main()
