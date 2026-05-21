# Watermark font assets

Runtime expects the bundled default file at:

`Assets/Fonts/default.ttf`

You may download DejaVu Sans and place a copy named `default.ttf` (same bytes as `DejaVuSans.ttf` from the DejaVu distribution). If this file is missing and no public CDN base is configured (`TENCENT_COS_PUBLIC_BASE_URL` / `R2_PUBLIC_BASE_URL`), the API falls back to an installed system font (best-effort) so Stub image generation still works in dev/CI.

Alternative filename used in older docs only:

`Assets/Fonts/DejaVuSans.ttf` (not read by code unless you rename or symlink to `default.ttf`)

Recommended source:
- https://dejavu-fonts.github.io/ (Download the DejaVu Sans TTF file)

Alternatively, you can use the direct file from the official repository:
- https://github.com/dejavu-fonts/dejavu-fonts/raw/master/ttf/DejaVuSans.ttf
