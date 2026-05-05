# App Materiales SGR

App web para almacenista de obra: catálogo de materiales por obra (importado de OPUS), requisiciones, recepciones y salidas con cargo a concepto OPUS.

Parte de la suite **sogrub-suite** (Firebase compartido con app-estimaciones y appsogrub/Bitácora).

## Stack
- Vanilla JS (ES modules nativos), HTML, CSS — sin frameworks ni bundler.
- Firebase Realtime Database + Authentication (proyecto `sogrub-suite`).
- SheetJS (CDN) para XLS/XLSX.

## Setup local
```bash
python serve.py 8081
```
Luego abre http://localhost:8081/

(Se usa el puerto 8081 para no chocar con app-estimaciones en 8080.)

## Documentación
Ver [CLAUDE.md](CLAUDE.md) para decisiones de producto, modelo de datos, contratos del buzón y cross-app con estimaciones/bitácora.
