"""Yangi ESP32 qurilmani bitta buyruq bilan tayyorlash (Windows va macOS/Linux).

    Windows:  proshivka-qil.cmd 12-maktab
    macOS:    ./proshivka-qil.sh 12-maktab
              ./proshivka-qil.sh "5-bogcha" --wifi "Maktab_WiFi"   (parol so'raladi, ekranda ko'rinmaydi)
              ./proshivka-qil.sh 12-maktab --token                 (shaxsiy qurilma tokeni yaratish)
              ./proshivka-qil.sh --token                           (izohsiz: panel device_id bo'yicha taniydi)

Qadamlar: portni topish -> MAC -> eski proshivka zaxirasi (backup/<mac>-eski.bin) -> yangi proshivka ->
muassasa (va berilsa Wi-Fi, token) xotiraga -> datchiklar va serverga yuborishni tekshirish -> tools/qurilmalar.csv.
"""
from __future__ import annotations

import argparse
import getpass
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    raise SystemExit("pyserial o'rnatilmagan: python -m pip install pyserial esptool platformio")

ROOT = Path(__file__).resolve().parent.parent
FIRMWARE = ROOT / "firmware"
BACKUP = ROOT / "backup"
REGISTRY = Path(__file__).resolve().parent / "qurilmalar.csv"
TOKENS = Path(__file__).resolve().parent / "tokenlar.csv"   # MAXFIY: git'ga qo'shilmaydi (.gitignore)
REG_HEADER = ["mac", "muassasa", "qurilma_id", "sana", "versiya", "ap_parol"]
USB_SERIAL_VIDS = {0x1A86, 0x10C4, 0x0403, 0x303A}
# v2.1.0: qotirilgan muassasa ro'yxati OLIB TASHLANDI (Andijon viloyati -
# 16 tuman, yuzlab obyekt). Izoh ERKIN matn; chegara proshivkadagi
# validInstitution() bilan AYNI bo'lishi SHART, aks holda skript yozgan
# qiymatni qurilma rad etardi va montajchi sababini tushunmasdi.
INSTITUTION_MAX_LEN = 64
INSTITUTION_RE = re.compile(r"^[A-Za-z0-9 ._-]{0,64}$")


# ---------------------------------------------------------------- vositalar

def _venv_tool(name: str) -> list[str] | None:
    for d, exe in ((ROOT / ".venv" / "Scripts", f"{name}.exe"), (ROOT / ".venv" / "bin", name)):
        if (d / exe).exists():
            return [str(d / exe)]
    return None


def esptool_cmd() -> list[str]:
    found = _venv_tool("esptool") or ([shutil.which("esptool")] if shutil.which("esptool") else None) \
        or ([shutil.which("esptool.py")] if shutil.which("esptool.py") else None)
    return found or [sys.executable, "-m", "esptool"]


def pio_cmd() -> list[str]:
    found = _venv_tool("pio") or ([shutil.which("pio")] if shutil.which("pio") else None) \
        or ([shutil.which("platformio")] if shutil.which("platformio") else None)
    if found:
        return found
    penv = Path.home() / ".platformio" / "penv" / ("Scripts/pio.exe" if os.name == "nt" else "bin/pio")
    if penv.exists():
        return [str(penv)]
    raise SystemExit("PlatformIO topilmadi: python -m pip install platformio")


# ---------------------------------------------------------------- yordamchi

def normalize(name: str) -> str:
    """Muassasa izohini tozalash.

    DIQQAT: bu qiymat endi faqat IZOH -- server kotyolni device_id orqali
    aniqlaydi va tanadagi institution_id ga ishonmaydi. Shuning uchun
    "noma'lum muassasa" degan xato ham yo'q: istalgan matn qabul qilinadi,
    faqat belgilar va uzunlik tekshiriladi (proshivkadagi validInstitution()
    bilan AYNI qoida).

    Apostroflar olib tashlanadi: ular JSON yukida qo'shimcha qochirish
    talab qiladi va turli klaviaturada turli belgi (' vs ‘) chiqadi.
    """
    s = name.strip().replace("‘", "").replace("’", "").replace("'", "").replace("`", "")
    s = re.sub(r"\s+", " ", s)
    if not INSTITUTION_RE.fullmatch(s):
        raise SystemExit(
            f"Muassasa izohi yaroqsiz: '{name}'. "
            f"Ko'pi bilan {INSTITUTION_MAX_LEN} belgi; faqat harf, raqam, bo'sh joy, - _ ."
        )
    return s


def load_registry() -> list[dict[str, str]]:
    if not REGISTRY.exists():
        return []
    lines = REGISTRY.read_text(encoding="utf-8").splitlines()
    head = lines[0].split(",") if lines else REG_HEADER
    rows = []
    for line in lines[1:]:
        if line.count(",") >= 2:
            vals = line.split(",")
            rows.append({k: (vals[i] if i < len(vals) else "") for i, k in enumerate(head)})
    return rows


def save_registry(row: dict[str, str]) -> None:
    rows = [r for r in load_registry() if r.get("mac") != row["mac"]]
    rows.append(row)
    out = [",".join(REG_HEADER)] + [",".join(r.get(k, "") for k in REG_HEADER) for r in rows]
    tmp = REGISTRY.with_suffix(".tmp")
    tmp.write_text("\n".join(out) + "\n", encoding="utf-8")
    tmp.replace(REGISTRY)


def save_token(device_id: str, inst: str, token: str) -> None:
    lines = TOKENS.read_text(encoding="utf-8").splitlines() if TOKENS.exists() else ["qurilma_id,muassasa,token,sana"]
    lines = [l for l in lines if not l.startswith(device_id + ",")]
    lines.append(f"{device_id},{inst},{token},{time.strftime('%Y-%m-%d')}")
    TOKENS.write_text("\n".join(lines) + "\n", encoding="utf-8")


def step(msg: str) -> None:
    print(f"\n==> {msg}", flush=True)


def find_port(preferred: str | None) -> str:
    if preferred:
        return preferred
    found = [p.device for p in list_ports.comports() if p.vid in USB_SERIAL_VIDS]
    # macOS'da bitta plata /dev/cu.* va /dev/tty.* bo'lib ko'rinadi - cu.* kerak
    found = [d for d in found if not d.startswith("/dev/tty.")] or found
    if not found:
        raise SystemExit("ESP32 USB orqali topilmadi. Kabelni (ma'lumot simi bor) va drayverni (CH340/CP210x) tekshiring.")
    if len(found) > 1:
        raise SystemExit(f"Bir nechta qurilma ulangan: {found}. Bittasini qoldiring yoki --port bering.")
    return found[0]


def run(cmd: list[str], cwd: Path | None = None, quiet: bool = False) -> str:
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = p.stdout + p.stderr
    if p.returncode != 0:
        print(out[-3000:])
        raise SystemExit(f"Buyruq xato bilan tugadi: {' '.join(map(str, cmd[:4]))} ...")
    if not quiet:
        lines = [l for l in out.strip().splitlines() if l.strip()]
        ok = [l for l in lines if "SUCCESS" in l or "Read " in l or "Hash of data verified" in l]
        print("   ", (ok or lines or [""])[-1].strip(" ="), flush=True)
    return out


def open_serial(port: str) -> serial.Serial:
    sp = serial.Serial()
    sp.port, sp.baudrate, sp.timeout = port, 115200, 0.2
    sp.dtr = False
    sp.rts = False
    sp.open()
    return sp


def read_for(sp: serial.Serial, seconds: float, until: str | tuple[str, ...] | None = None,
             show=lambda l: True) -> list[str]:
    if isinstance(until, str):
        until = (until,)
    lines, end = [], time.time() + seconds
    while time.time() < end:
        raw = sp.readline()
        if not raw:
            continue
        line = raw.decode("utf-8", "replace").rstrip()
        if not line or line.startswith("[DATA]") or "wifi:" in line:
            continue
        lines.append(line)
        if show(line):
            print("   ", line, flush=True)
        if until and any(u in line for u in until):
            break
    return lines


def command(sp: serial.Serial, cmd: str, expect: str | tuple[str, ...], seconds: float = 25, tries: int = 2,
            show=lambda l: True) -> list[str]:
    """Buyruq yuborib, javobni kutadi. Qurilma HTTPS yuborish bilan band bo'lsa (20 s gacha), qayta urinadi."""
    got: list[str] = []
    exp = (expect,) if isinstance(expect, str) else expect
    for _ in range(tries):
        sp.reset_input_buffer()
        sp.write(cmd.encode())
        got = read_for(sp, seconds, until=exp, show=show)
        if any(e in l for l in got for e in exp):
            return got
    return got


def info(sp: serial.Serial) -> dict[str, str]:
    lines = command(sp, "i", "[OTA] Versiya", seconds=10, show=lambda l: False)
    text = "\n".join(lines)
    out = {}
    for key, rx in (("versiya", r"versiya: ([\w.\-]+)"), ("ap_parol", r"AP paroli: (\d{8})"),
                    ("wifi", r"\[INFO\] Wi-Fi: ([^,]+)"), ("muassasa", r"muassasa: ([\w\-()' ]+), rejim")):
        m = re.search(rx, text)
        if m:
            out[key] = m.group(1).strip()
    return out


# ---------------------------------------------------------------- asosiy

def main() -> None:
    ap = argparse.ArgumentParser(description="ESP32 issiqlik monitoringi qurilmasini tayyorlash")
    ap.add_argument("muassasa", nargs="?", default="",
                    help="ixtiyoriy izoh, masalan: 12-maktab. Bo'sh qoldirish mumkin.")
    ap.add_argument("--wifi", help="muassasa Wi-Fi nomi (ixtiyoriy)")
    ap.add_argument("--parol", help="Wi-Fi paroli (berilmasa so'raladi; ochiq tarmoq uchun bo'sh qoldiring)")
    ap.add_argument("--token", action="store_true",
                    help="shaxsiy qurilma tokeni yaratib yozish (server shaxsiy tokenlarni qo'llagandan keyin)")
    ap.add_argument("--port")
    ap.add_argument("--zaxirasiz", action="store_true", help="eski proshivkani zaxiralamaslik")
    ap.add_argument("--majburiy", action="store_true", help="boshqa muassasaga yozilgan platani qayta yozish")
    args = ap.parse_args()
    inst = normalize(args.muassasa)
    if not (FIRMWARE / "include" / "secrets.h").exists():
        raise SystemExit("firmware/include/secrets.h yo'q. secrets.example.h dan nusxalab, API_TOKEN ni yozing.")
    wifi_pass = None
    if args.wifi:
        wifi_pass = args.parol if args.parol is not None else getpass.getpass(f"'{args.wifi}' paroli: ")
        if wifi_pass and not 8 <= len(wifi_pass) <= 63:
            raise SystemExit("Wi-Fi paroli 8-63 belgi bo'lishi kerak (ochiq tarmoq uchun bo'sh).")
    esptool = esptool_cmd()

    step(f"Muassasa: {inst}. Qurilma qidirilmoqda")
    port = find_port(args.port)
    out = run(esptool + ["--port", port, "read-mac"], quiet=True)
    m = re.search(r"MAC:\s*([0-9a-fA-F:]{17})", out)
    if not m:
        print(out[-1500:])
        raise SystemExit("MAC manzilni o'qib bo'lmadi (esptool javobi kutilganidek emas).")
    mac = m.group(1).lower()
    key = mac.replace(":", "")
    device_id = "esp32-" + key
    print(f"    Port {port}, MAC {mac}, qurilma ID {device_id}", flush=True)

    registry = load_registry()
    mine = next((r for r in registry if r["mac"] == key), None)
    if mine and mine["muassasa"] != inst and not args.majburiy:
        raise SystemExit(f"Bu plata allaqachon {mine['muassasa']} ga yozilgan. Boshqa platani ulang "
                         f"yoki ataylab o'zgartirish uchun --majburiy qo'shing.")
    taken = [r["qurilma_id"] for r in registry if r["muassasa"] == inst and r["mac"] != key]
    if taken:
        print(f"    DIQQAT: {inst} uchun boshqa plata ham bor ({', '.join(taken)}). Eskisini o'chirib qo'ying, "
              f"aks holda ma'lumot ikki manbadan keladi.")

    backup = BACKUP / f"{key}-eski.bin"
    if args.zaxirasiz:
        step("Zaxira o'tkazib yuborildi")
    elif backup.exists():
        step(f"Zaxira allaqachon bor: {backup.name}")
    else:
        fid = run(esptool + ["--port", port, "flash-id"], quiet=True)
        sm = re.search(r"Detected flash size:\s*(\d+)MB", fid)
        size_mb = int(sm.group(1)) if sm else 4
        step(f"Eski proshivka zaxiraga olinmoqda ({size_mb} MB, ~{size_mb * 25} soniya)")
        BACKUP.mkdir(exist_ok=True)
        part = backup.with_suffix(".part")
        run(esptool + ["--port", port, "--baud", "460800", "read-flash", "0", hex(size_mb * 1024 * 1024), str(part)])
        part.replace(backup)  # faqat to'liq o'qilgan zaxira saqlanadi
        print("    Eslatma: zaxirada eski Wi-Fi parollari bor - backup/ papkasini tarqatmang.")

    step("Yangi proshivka yozilmoqda (~40 soniya, birinchi marta platforma yuklanadi - uzoqroq)")
    run(pio_cmd() + ["run", "-t", "upload", "--upload-port", port], cwd=FIRMWARE)

    step("Qurilma ishga tushishini kutish")
    sp = open_serial(port)
    read_for(sp, 4, show=lambda l: l.startswith(("===", "[INFO]", "[SENSOR]", "[LCD]", "[OTA]")))
    st = info(sp)
    if not st.get("versiya"):
        sp.close()
        raise SystemExit("Qurilma serial'da javob bermadi. Kabelni qayta ulab, skriptni qayta ishga tushiring.")
    print(f"    Proshivka v{st['versiya']}")

    step("Muassasa xotiraga yozilmoqda")
    got = command(sp, f"I{inst}\n", "[SET] Muassasa")
    if not any(f"[SET] Muassasa: {inst}" in l for l in got):
        sp.close()
        raise SystemExit("Muassasani yozib bo'lmadi (qurilma javob bermadi). Qurilma YUBORMAYDI - qayta urinib ko'ring.")

    if args.wifi:
        step(f"Wi-Fi yozilmoqda: {args.wifi}")
        got = command(sp, f"W{args.wifi}\t{wifi_pass}\n", ("[SET] Wi-Fi saqlandi", "[SET] Wi-Fi nomi"))
        if not any("[SET] Wi-Fi saqlandi" in l for l in got):
            print("    DIQQAT: Wi-Fi yozilmadi - joyida Wi-Fi tugmasi orqali sozlang.")

    token = None
    if args.token:
        step("Shaxsiy token yozilmoqda")
        token = secrets.token_urlsafe(24)  # 32 belgi [A-Za-z0-9_-]
        got = command(sp, f"T{token}\n", ("[SET] Token: shaxsiy", "[SET] Token noto'g'ri"), show=lambda l: False)
        if not any("[SET] Token: shaxsiy" in l for l in got):
            sp.close()
            raise SystemExit("Tokenni yozib bo'lmadi.")
        save_token(device_id, inst, token)

    step("Tekshiruv: datchiklar, Wi-Fi, serverga yuborish (~1 daqiqa)")
    lines = command(sp, "s", "[SENSOR] Chiqish", seconds=10)
    connected = False
    for _ in range(6):
        st = info(sp)
        if st.get("wifi") == "ulangan":
            connected = True
            break
        time.sleep(3)
    http: list[str] = []
    if connected:
        http = command(sp, "m", ("[HTTP] Yuborildi", "[HTTP] Server javobi", "[HTTP] Xato", "[HTTP] O'lchov yo'q",
                                 "[HTTP] Muassasa"), seconds=30)
    sp.close()

    save_registry({"mac": key, "muassasa": inst, "qurilma_id": device_id, "sana": time.strftime("%Y-%m-%d"),
                   "versiya": st.get("versiya", ""), "ap_parol": st.get("ap_parol", "")})

    text = "\n".join(lines + http)
    found = {m.group(1) for m in re.finditer(r"\[SENSOR\] (Kirish|Chiqish): GPIO\d+ [0-9A-F]{16}", text)}
    missing = [n for n in ("Kirish", "Chiqish") if n not in found]
    print("\n================ NATIJA ================")
    print(f"Muassasa:   {inst}")
    print(f"Qurilma ID: {device_id}")
    print(f"Proshivka:  v{st.get('versiya', '?')}")
    print(f"AP paroli:  {st.get('ap_parol', '?')}  (telefondan sozlash uchun; LCD'da ham chiqadi)")
    if missing:
        print(f"Datchiklar: {len(found)} ta. TOPILMADI: {', '.join(missing)} - simi/ulagichini tekshiring!")
    else:
        print("Datchiklar: 2 ta (kirish va chiqish)")
    m = re.search(r"\[HTTP\] (Yuborildi \(\d+\)|Server javobi \d+.*|Xato .*|O'lchov yo'q.*)", text)
    if m and m.group(1).startswith("Yuborildi"):
        print(f"Server:     ma'lumot qabul qilindi ({m.group(1)}) - dashboardda ko'rinadi")
    elif m:
        print(f"Server:     MUAMMO - {m.group(1)}")
    elif not connected:
        print("Wi-Fi:      ulanmagan. Joyida Wi-Fi tugmasini 5 s bosib turing va telefondan Wi-Fi tanlang.")
    if token:
        print(f"Token:      {token}")
        print("            tools/tokenlar.csv ga yozildi (MAXFIY). Dashboardda shu qurilmaga kiriting.")
    print("========================================")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(1)
