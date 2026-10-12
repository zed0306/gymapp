"""Скачивает фото тренажёров (Wikimedia Commons, Flickr) и обновляет список авторов.

    python3 tools/fetch_images.py          # докачать недостающие
    python3 tools/fetch_images.py --force  # перекачать все

Источник истины — tools/images.json: id тренажёра → файл на Commons, автор, лицензия
и (по желанию) crop — доля кадра [left, top, right, bottom], которую оставить.
Нужны пакеты requests и Pillow.
"""

import hashlib
import io
import json
import sys
import time
import urllib.parse
from pathlib import Path

import requests
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "img" / "equipment"
UA = {"User-Agent": "gymapp-thumbnail-collector/1.0 (https://github.com/zed0306/gymapp)"}
SIZE = (720, 540)


def commons_url(title: str, width: int | None) -> str:
    name = title.removeprefix("File:").replace(" ", "_")
    h = hashlib.md5(name.encode()).hexdigest()
    q = urllib.parse.quote(name)
    if not width:
        return f"https://upload.wikimedia.org/wikipedia/commons/{h[0]}/{h[:2]}/{q}"
    return f"https://upload.wikimedia.org/wikipedia/commons/thumb/{h[0]}/{h[:2]}/{q}/{width}px-{q}"


def download(urls: list[str]) -> bytes:
    # Commons часто отвечает 429 — пробуем разные размеры по очереди и ждём
    for attempt in range(18):
        url = urls[attempt % len(urls)]
        r = requests.get(url, headers=UA, timeout=60)
        if r.ok and r.headers.get("content-type", "").startswith("image/"):
            return r.content
        wait = max(int(r.headers.get("retry-after", 0) or 0), 15)
        print(f"  {r.status_code}, жду {wait} с", flush=True)
        time.sleep(min(wait + 2, 660))
    raise RuntimeError(f"не удалось скачать {urls[0]}")


def fit(img: Image.Image, crop: list[float] | None) -> Image.Image:
    img = img.convert("RGB")
    if crop:
        w, h = img.size
        img = img.crop((int(crop[0] * w), int(crop[1] * h), int(crop[2] * w), int(crop[3] * h)))
    w, h = img.size
    target = SIZE[0] / SIZE[1]
    if w / h > target:
        nw = int(h * target)
        img = img.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    else:
        nh = int(w / target)
        top = max(0, int((h - nh) * 0.4))  # чуть выше центра — тренажёр обычно там
        img = img.crop((0, top, w, top + nh))
    # маленькие фото не растягиваем
    return img.resize(SIZE, Image.LANCZOS) if img.width > SIZE[0] else img


def write_credits(meta: dict) -> None:
    items = [
        {"id": k, "author": v["author"], "license": v["license"], "page": v["page"]}
        for k, v in meta.items()
        if (OUT / f"{k}.jpg").exists()
    ]
    js = "// Авторы фото тренажёров (Wikimedia Commons). Генерируется tools/fetch_images.py\n"
    js += "export const CREDITS = " + json.dumps(items, ensure_ascii=False, indent=2) + ";\n"
    (ROOT / "js" / "data" / "credits.js").write_text(js, encoding="utf-8")
    lines = [
        "# Авторы фото",
        "",
        "Фото тренажёров — с Wikimedia Commons и Flickr, по свободным лицензиям (CC0, CC BY, CC BY-SA, public domain). Изображения уменьшены и обрезаны до 4:3.",
        "",
        "| Тренажёр | Файл | Автор | Лицензия |",
        "|---|---|---|---|",
    ]
    for k, v in meta.items():
        if (OUT / f"{k}.jpg").exists():
            lic = f"[{v['license']}]({v['license_url']})" if v.get("license_url") else v["license"]
            lines.append(f"| {k} | [{v['title'].removeprefix('File:')}]({v['page']}) | {v['author']} | {lic} |")
    (ROOT / "CREDITS.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    force = "--force" in sys.argv
    meta = json.loads((ROOT / "tools" / "images.json").read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    # сначала Flickr (качается быстро), потом Commons
    for key, m in sorted(meta.items(), key=lambda kv: "url" not in kv[1]):
        dest = OUT / f"{key}.jpg"
        if dest.exists() and not force:
            continue
        if m.get("url"):  # не с Commons (например, Flickr)
            urls = [m["url"]]
        elif m.get("w", 0) > 1280 and not m["title"].lower().endswith(".webp"):
            urls = [commons_url(m["title"], w) for w in (1280, 960)]
        else:
            urls = [commons_url(m["title"], None)]
        print(f"{key}: {m['title']}", flush=True)
        try:
            data = download(urls)
        except RuntimeError as e:
            print("  пропуск:", e)
            continue
        fit(Image.open(io.BytesIO(data)), m.get("crop")).save(dest, "JPEG", quality=80, optimize=True, progressive=True)
        write_credits(meta)
        time.sleep(1 if m.get("url") else 8)
    write_credits(meta)


if __name__ == "__main__":
    main()
