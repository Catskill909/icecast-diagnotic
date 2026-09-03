#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
#  Fetch the DB-IP ASN Lite database.
#
#  WHY THIS EXISTS AT ALL. The database has to reach the running container, and
#  on a managed panel there is no shell and no docker CLI — so "copy a file onto
#  the persistent volume" is not an available action. The only route left is to
#  put the file in the IMAGE, at build time. This script is that step, kept out
#  of the Dockerfile so it can be run and tested on its own.
#
#  WHY DB-IP AND NOT MAXMIND. Baking a database into an image is redistribution.
#  DB-IP Lite is CC BY 4.0, which permits it as long as the credit is displayed
#  — and the app renders that credit from the file it actually loaded, so the
#  obligation is met wherever the data is shown. MaxMind's GeoLite2 EULA
#  restricts redistributing the database, so it must NOT be baked in this way;
#  a GeoLite2 deployment supplies its own file and sets GEOIP_ASN_DB to it.
#
#  WHY THE MONTH IS COMPUTED. DB-IP publishes dated URLs and offers no "latest"
#  alias — verified 2026-09-02, where dbip-asn-lite.mmdb.gz and
#  dbip-asn-lite-latest.mmdb.gz both 404. Roughly three months are retained, so
#  a hardcoded URL would build fine today and 404 next quarter. The current
#  month is tried first, then earlier ones: on the 1st the new file may not be
#  published yet, and a monitor must not fail to build over that.
#
#  Usage:  fetch-geodb.sh <output-path>
#  Exit:   0 on success, 1 if no month could be fetched.
# ═══════════════════════════════════════════════════════════════════════════

set -eu

OUT="${1:?usage: fetch-geodb.sh <output-path>}"
TMP="${OUT}.gz.tmp"

# How many months back to try. Three is what DB-IP retains.
MONTHS="${GEODB_MONTHS_BACK:-3}"

log() { echo "[geodb] $*" >&2; }

i=0
while [ "$i" -lt "$MONTHS" ]; do
  # `date -d` is GNU, `date -v` is BSD. Alpine's busybox date supports neither
  # reliably for month arithmetic, so the month is stepped by hand.
  Y=$(date -u +%Y)
  M=$(date -u +%m)
  # STRIP THE LEADING ZERO BEFORE ANY ARITHMETIC. `date +%m` gives 08 and 09,
  # which POSIX shell arithmetic reads as invalid OCTAL — a build that works all
  # year and then fails through August and September only. The bash idiom for
  # this is `10#$M`, which busybox ash (Alpine's shell, and what the image
  # actually runs) does not support, so the zero is removed by expansion.
  M=${M#0}
  M=$((M - i))
  while [ "$M" -lt 1 ]; do
    M=$((M + 12))
    Y=$((Y - 1))
  done
  STAMP=$(printf '%04d-%02d' "$Y" "$M")
  URL="https://download.db-ip.com/free/dbip-asn-lite-${STAMP}.mmdb.gz"

  log "trying ${STAMP}"
  if curl -fsSL --max-time 180 -o "$TMP" "$URL"; then
    # A truncated or error-page download must not become a "database" that
    # silently answers every lookup with nothing. Verify before installing.
    if ! gzip -t "$TMP" 2>/dev/null; then
      log "${STAMP}: downloaded file is not valid gzip — discarding"
      rm -f "$TMP"
      i=$((i + 1))
      continue
    fi
    gzip -dc "$TMP" > "${OUT}.tmp"
    rm -f "$TMP"

    # Every MMDB file ends with this marker before its metadata section. It is
    # the cheapest proof that what arrived is the format we think it is.
    #
    # LC_ALL=C IS LOAD-BEARING. Under a UTF-8 locale BSD grep rejects the binary
    # pattern outright ("illegal byte sequence") and reports NO MATCH — so the
    # check failed every valid database it was given. It failed closed, which is
    # the right direction, but a guard that rejects everything is not a guard.
    if ! LC_ALL=C grep -qa "$(printf '\xab\xcd\xefMaxMind.com')" "${OUT}.tmp"; then
      log "${STAMP}: not an MMDB file — discarding"
      rm -f "${OUT}.tmp"
      i=$((i + 1))
      continue
    fi

    mv "${OUT}.tmp" "$OUT"
    log "installed ${STAMP} -> ${OUT} ($(wc -c < "$OUT") bytes)"
    exit 0
  fi

  log "${STAMP}: not available"
  i=$((i + 1))
done

log "no database could be fetched after ${MONTHS} attempt(s)"
exit 1
