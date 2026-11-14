#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Bazani tayyorlash: rol + baza.
#
# ⚠️ Skript `postgres` superuser nomidan ishlaydi — shuning uchun uni
# `sudo` bilan chaqirish kerak. Ilovaning O'ZI esa hech qachon
# superuser bilan ulanmaydi: alohida rol yaratiladi va unga faqat
# o'z bazasi beriladi.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

DB_USER="${DB_USERNAME:-issiqlik}"
DB_PASS="${DB_PASSWORD:-issiqlik}"
DB_NAME="${DB_NAME:-issiqlik_db}"

echo "▶ Rol: ${DB_USER}, baza: ${DB_NAME}"

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';
  ELSE
    ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}';
  END IF;
END
\$\$;
SQL

# ⚠️ CREATE DATABASE tranzaksiya ichida ishlamaydi, shuning uchun
# alohida chaqiriladi va mavjudligi oldindan tekshiriladi.
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  sudo -u postgres createdb -O "${DB_USER}" "${DB_NAME}"
  echo "✔ Baza yaratildi: ${DB_NAME}"
else
  echo "• Baza allaqachon mavjud: ${DB_NAME}"
fi

sudo -u postgres psql -v ON_ERROR_STOP=1 -d "${DB_NAME}" <<SQL
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
GRANT ALL ON SCHEMA public TO ${DB_USER};
ALTER SCHEMA public OWNER TO ${DB_USER};
SQL

echo "✔ Tayyor. Endi: npm run migration:run && npm run seed"
