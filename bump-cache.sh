#!/usr/bin/env bash
# Cache-busting de app-materiales · correr ANTES de cada push que toque js/ o css/
#
#   bash bump-cache.sh
#
# Por qué existe: la app carga ES-modules nativos sin bundler. index.html
# versionaba solo main.js, pero sus imports estáticos (./views/recepciones.js,
# ./services/db.js, …) se pedían sin query y GitHub Pages + el navegador los
# seguían sirviendo de caché. Resultado: deploys a medias — main.js nuevo
# llamando a módulos viejos.
#
# La solución es un import map con una URL versionada por módulo: los imports
# estáticos se resuelven contra el mapa, así que basta bumpear el sello aquí
# para invalidar TODO el grafo de una vez. Un navegador sin soporte de import
# maps simplemente lo ignora y queda como antes (nunca peor).
#
# Este script regenera el bloque <script type="importmap"> completo y el sello
# del entry point, entre los marcadores IMPORTMAP-AUTO de index.html.
set -euo pipefail
cd "$(dirname "$0")"

STAMP="${1:-$(date +%Y%m%d-%H%M)}"
HTML="index.html"

[ -f "$HTML" ] || { echo "No encuentro $HTML" >&2; exit 1; }

# Todos los módulos del proyecto, en orden estable.
mapfile -t MODULES < <(find js -name '*.js' | sort)
[ "${#MODULES[@]}" -gt 0 ] || { echo "No encontré módulos en js/" >&2; exit 1; }

BLOCK="$(mktemp)"
trap 'rm -f "$BLOCK"' EXIT

{
  echo '  <!-- IMPORTMAP-AUTO:start · generado por bump-cache.sh — no editar a mano -->'
  echo '  <script type="importmap">'
  echo '  {'
  echo '    "imports": {'
  last=$(( ${#MODULES[@]} - 1 ))
  for i in "${!MODULES[@]}"; do
    m="${MODULES[$i]}"
    comma=','
    [ "$i" -eq "$last" ] && comma=''
    printf '      "./%s": "./%s?v=%s"%s\n' "$m" "$m" "$STAMP" "$comma"
  done
  echo '    }'
  echo '  }'
  echo '  </script>'
  echo '  <script type="module">'
  printf "    import('./js/main.js?v=%s');\n" "$STAMP"
  echo '  </script>'
  echo '  <!-- IMPORTMAP-AUTO:end -->'
} > "$BLOCK"

python3 - "$HTML" "$BLOCK" <<'PY'
import re, sys
html_path, block_path = sys.argv[1], sys.argv[2]
html  = open(html_path, encoding='utf-8').read()
block = open(block_path, encoding='utf-8').read().rstrip('\n')
pat = re.compile(r'[ \t]*<!-- IMPORTMAP-AUTO:start.*?<!-- IMPORTMAP-AUTO:end -->', re.S)
if not pat.search(html):
    sys.exit('No encontré los marcadores IMPORTMAP-AUTO en index.html')
open(html_path, 'w', encoding='utf-8').write(pat.sub(lambda _: block, html, count=1))
PY

# El CSS sí son <link> normales: se versionan igual que en appsogrub.
python3 - "$HTML" "$STAMP" <<'PY'
import re, sys
html_path, stamp = sys.argv[1], sys.argv[2]
html = open(html_path, encoding='utf-8').read()
html = re.sub(r'(href="css/[^"?]+\.css)(\?v=[^"]*)?"', rf'\1?v={stamp}"', html)
open(html_path, 'w', encoding='utf-8').write(html)
PY

echo "Cache-buster bumpeado a ?v=$STAMP (${#MODULES[@]} módulos + css)"
