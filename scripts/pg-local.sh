#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# LOYIHANING O'Z PostgreSQL KLASTERI.
#
# ⚠️ Nega tizim klasteri (5432) EMAS: unga ulanish uchun `sudo` yoki
# `postgres` rolining paroli kerak. Bu klaster esa JORIY foydalanuvchi
# nomidan ishlaydi — hech qanday maxsus huquq talab qilmaydi, lekin
# ma'lumot doimiy saqlanadi (`~/.local/share/issiqlik`).
#
# ⚠️ Port 5442 — tizim klasterlari (5432, 5433) bilan to'qnashmasligi
# uchun. `.env` dagi `DB_PORT` ham aynan shu.
#
#   bash scripts/pg-local.sh start|stop|status|restart|psql
# ──────────────────────────────────────────────────────────────
set -euo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
ROOT="$HOME/.local/share/issiqlik"
PGDATA="$ROOT/pgdata"
PGSOCK="$ROOT/run"
LOG="$ROOT/server.log"
PORT="${DB_PORT:-5442}"
DB_USER="${DB_USERNAME:-issiqlik}"
DB_NAME="${DB_NAME:-issiqlik_db}"

usage() { echo "Ishlatish: bash scripts/pg-local.sh {start|stop|restart|status|psql|init}"; exit 1; }
[ $# -ge 1 ] || usage

case "$1" in
  init)
    if [ -d "$PGDATA" ]; then
      echo "• Klaster allaqachon mavjud: $PGDATA"
      exit 0
    fi
    mkdir -p "$PGDATA" "$PGSOCK"
    PWFILE="$(mktemp)"
    # ⚠️ Parol vaqtinchalik faylda va faqat egasiga ko'rinadi; initdb
    # tugashi bilan o'chiriladi — buyruq qatorida uzatilsa, u `ps`
    # chiqishida har kimga ko'rinib qolardi.
    chmod 600 "$PWFILE"
    printf '%s' "${DB_PASSWORD:-issiqlik}" > "$PWFILE"
    "$PGBIN/initdb" -D "$PGDATA" -U "$DB_USER" \
      --auth-local=trust --auth-host=scram-sha-256 \
      --encoding=UTF8 --locale=C.UTF-8 --pwfile="$PWFILE" >/dev/null
    rm -f "$PWFILE"
    echo "✔ Klaster yaratildi: $PGDATA"
    ;;

  start)
    "$PGBIN/pg_ctl" -D "$PGDATA" -l "$LOG" -w -t 30 \
      -o "-p $PORT -k $PGSOCK -c listen_addresses=127.0.0.1" start
    # Baza yo'q bo'lsa — yaratiladi (buyruq qayta ishga tushirilsa ham xavfsiz).
    if ! PGPASSWORD="${DB_PASSWORD:-issiqlik}" psql -h 127.0.0.1 -p "$PORT" -U "$DB_USER" \
         -d postgres -tAc "select 1 from pg_database where datname='$DB_NAME'" | grep -q 1; then
      PGPASSWORD="${DB_PASSWORD:-issiqlik}" "$PGBIN/createdb" \
        -h 127.0.0.1 -p "$PORT" -U "$DB_USER" -O "$DB_USER" "$DB_NAME"
      echo "✔ Baza yaratildi: $DB_NAME"
    fi
    echo "✔ PostgreSQL ishlayapti: 127.0.0.1:$PORT"
    ;;

  stop)
    "$PGBIN/pg_ctl" -D "$PGDATA" -m fast -w -t 30 stop
    ;;

  restart)
    "$0" stop || true
    "$0" start
    ;;

  status)
    "$PGBIN/pg_ctl" -D "$PGDATA" status || true
    ;;

  psql)
    shift
    PGPASSWORD="${DB_PASSWORD:-issiqlik}" psql -h 127.0.0.1 -p "$PORT" -U "$DB_USER" -d "$DB_NAME" "$@"
    ;;

  *) usage ;;
esac
