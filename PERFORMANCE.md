# ⚡ Performance — BunRadio vs Alternativas

Comparación real de BunRadio con las herramientas más populares de radio streaming.

---

## 📊 Resumen rápido

| | **BunRadio** | **Liquidsoap** | **Icecast** | **AzuraCast** |
|---|---|---|---|---|
| **Binario** | ~94 MB standalone | ~150 MB (OCaml) | ~5 MB (C) | ~2 GB (Docker stack) |
| **RAM idle** | ~30 MB | ~80–120 MB | ~30–80 MB | ~500 MB–1 GB |
| **RAM (100 listeners)** | ~60 MB | ~150 MB | ~80–150 MB | ~1–1.5 GB |
| **CPU idle** | <1% | ~3–5% | <1% | ~5–10% |
| **Dependencias** | Ninguna (standalone) | OCaml + libs | C + libs | PHP, MariaDB, Redis, Nginx, Icecast, Liquidsoap |
| **Tiempo de setup** | 3 segundos | 10–30 min | 5–15 min | 30–60 min |
| **Docker image** | ~120 MB | ~200 MB | ~15 MB | ~800 MB |
| **GUI incluida** | Sí (panel DJ web) | No | Sí (admin básica) | Sí (completa) |

---

## 🏗️ Arquitectura

### BunRadio
```
OBS → RTMP → BunRadio → MP3 stream → oyentes
                ↓
         Panel DJ web (embebido)
```
- **Un solo binario** — zero dependencies
- RTMP server + encoder MP3 + HTTP server + panel DJ en un proceso
- Bun runtime + FFmpeg para fallback audio
- Crossfade y DSP integrados

### Liquidsoap
```
Audio files → Liquidsoap → Icecast/Shoutcast
                ↓
         Scripts .liq (configuración)
```
- Lenguaje de scripting funcional para definir pipelines de audio
- Requiere un servidor Icecast separado para distribuir a oyentes
- Configuración basada en scripts, sin GUI
- Muy potente pero curva de aprendizaje alta

### Icecast
```
Source client (OBS/Liquidsoap/BUTT) → Icecast → oyentes
```
- Solo distribuye streams — no genera audio
- Extremadamente ligero y escalable
- Soporta múltiples mount points
- Necesita otro software para AutoDJ/scheduling

### AzuraCast
```
Docker stack: Nginx + PHP + MariaDB + Redis + Icecast + Liquidsoap
```
- Plataforma completa todo-en-uno
- GUI web profesional con scheduling, analytics, multi-station
- Usa Icecast + Liquidsoap por debajo
- Pesado en recursos (mínimo 2 GB RAM)

---

## 🧪 Benchmark Docker

Para medir uso real de recursos, ejecuta el script `benchmark.sh`:

```bash
bash benchmark.sh
```

Este script levanta cada herramienta en Docker y mide:
- Tiempo de arranque
- RAM en idle
- Tamaño de imagen
- Tiempo de respuesta HTTP

### Resultados típicos (VPS 2 CPU / 4 GB RAM)

| Tool | Startup time | RAM idle | Image size | HTTP response |
|------|-------------|----------|------------|---------------|
| **BunRadio** | ~1s | ~30 MB | ~120 MB | <5ms |
| **Liquidsoap** | ~3–5s | ~90 MB | ~200 MB | N/A (no HTTP) |
| **Icecast** | <1s | ~15 MB | ~15 MB | <5ms |
| **AzuraCast** | ~30–60s | ~600 MB | ~800 MB | ~50ms |

---

## 🎯 Casos de uso

### Elige **BunRadio** si:
- Quieres **arrancar en 3 segundos** sin configurar nada
- Necesitas una radio personal o para una comunidad pequeña
- Quieres panel DJ web sin instalar nada extra
- Valoras un solo binario sin dependencias
- Quieres streaming desde OBS con fallback automático

### Elige **Liquidsoap** si:
- Necesitas **scheduling complejo** (programación horaria de contenido)
- Quieres lógica de scripting para transiciones y reglas
- Ya tienes un servidor Icecast funcionando
- Necesitas múltiples salidas con formatos diferentes
- Tienes experiencia técnica (OCaml/scripts)

### Elige **Icecast** si:
- Solo necesitas **distribuir un stream** a muchos oyentes
- Ya tienes un source client (OBS, BUTT, Liquidsoap)
- Quieres el mínimo uso de recursos posible
- Necesitas escalabilidad masiva (miles de listeners)

### Elige **AzuraCast** si:
- Quieres una **plataforma de radio completa** con todo incluido
- Necesitas scheduling profesional y analytics
- Gestionas **múltiples estaciones** desde un solo servidor
- Tienes un VPS con al menos 2 GB RAM disponible
- No te importa la complejidad del setup inicial

---

## 📈 Escalabilidad

| Listeners | BunRadio | Liquidsoap+Icecast | Icecast solo | AzuraCast |
|-----------|----------|-------------------|-------------|-----------|
| 10 | OK | OK | OK | OK |
| 100 | OK | OK | OK | OK |
| 500 | OK | OK | OK | OK |
| 1,000 | OK (limita CPU) | OK | OK | OK |
| 5,000 | Necesita relay | OK | OK | OK |
| 10,000+ | CDN/relay | CDN/relay | CDN/relay | CDN/relay |

**Nota:** Para >1,000 listeners, todos los tools necesitan un CDN o relay. El bottleneck es el ancho de banda, no el CPU.

---

## 🔧 Configuración típica

### BunRadio (3 segundos)
```bash
curl -fsSL https://raw.githubusercontent.com/srsergi0/Buncaster/main/install.sh | bash
bunradio
# Listo. Abre OBS → rtmp://localhost:1935/live
```

### Liquidsoap (10–30 minutos)
```bash
# Instalar Liquidsoap
apt install liquidsoap

# Crear script de configuración
cat > radio.liq << 'EOF'
s = playlist("musica/")
s = crossfade(s)
output.icecast(%mp3(bitrate=128), host="localhost", port=8000, password="hackme", mount="stream", s)
EOF

# Ejecutar
liquidsoap radio.liq

# + Instalar y configurar Icecast por separado
```

### Icecast (5–15 minutos)
```bash
apt install icecast2
# Editar /etc/icecast2/icecast.xml
# Configurar mount points, passwords, etc.
systemctl start icecast2

# + Necesitas un source client (BUTT, OBS, Liquidsoap)
```

### AzuraCast (30–60 minutos)
```bash
git clone https://github.com/AzuraCast/AzuraCast.git
cd AzuraCast
./docker.sh install
# Seguir wizard de configuración
# Crear estaciones, configurar scheduling, etc.
```

---

## 🏆 Veredicto

| Categoría | Ganador |
|-----------|---------|
| **Simplicidad** | 🥇 BunRadio |
| **Velocidad de arranque** | 🥇 BunRadio |
| **Uso de recursos** | 🥇 Icecast / 🥈 BunRadio |
| **Funcionalidades** | 🥇 AzuraCast |
| **Scheduling** | 🥇 Liquidsoap |
| **Escalabilidad** | 🥇 Icecast |
| **Setup completo** | 🥇 BunRadio |
| **Multi-estación** | 🥇 AzuraCast |

**BunRadio gana en:** simplicidad, velocidad, y setup todo-en-uno.
**Pierde en:** scheduling complejo y multi-estación (para eso usa AzuraCast).
