#!/bin/bash
# =============================================================
# BunRadio - Instalador rápido
# =============================================================
# Uso: curl -fsSL https://raw.githubusercontent.com/srsergi0/Buncaster/main/install.sh | bash
# O:   bash install.sh
# Soporta: Linux, macOS, Windows (WSL/Git Bash), Termux (Android)
# =============================================================

set -e

REPO="srsergi0/Buncaster"
INSTALL_DIR="${BUNRADIO_DIR:-$HOME/.bunradio}"

# Detectar si podemos usar colores
if [ -t 1 ] && [ -n "$TERM" ] && [ "$TERM" != "dumb" ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    CYAN='\033[0;36m'
    NC='\033[0m'
else
    RED=''
    GREEN=''
    YELLOW=''
    CYAN=''
    NC=''
fi

echo ""
echo "  ============================================"
echo "         B U N R A D I O   I N S T A L L     "
echo "  ============================================"
echo ""

# Detectar SO, arquitectura y entorno
detect_platform() {
    local os=$(uname -s | tr '[:upper:]' '[:lower:]')
    local arch=$(uname -m)
    
    # Detectar Termux (Android)
    if [ -d "/data/data/com.termux" ] || [ "$TERMUX_VERSION" ]; then
        echo "linux-arm64"
        return
    fi
    
    case "$os" in
        linux)
            case "$arch" in
                x86_64)  echo "linux-x64" ;;
                aarch64|arm64) echo "linux-arm64" ;;
                armv7l|armv6l) echo "linux-arm64" ;;
                *)       echo "linux-x64" ;;
            esac
            ;;
        darwin)
            case "$arch" in
                x86_64)  echo "macos-x64" ;;
                arm64)   echo "macos-arm64" ;;
                *)       echo "macos-arm64" ;;
            esac
            ;;
        msys*|mingw*|cygwin*|nt*|windows*)
            echo "windows-x64"
            ;;
        *)
            echo "linux-x64"
            ;;
    esac
}

# Obtener la última versión desde GitHub API
get_latest_version() {
    local version
    if command -v curl &> /dev/null; then
        version=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null | grep '"tag_name"' | head -1 | cut -d '"' -f 4)
    elif command -v wget &> /dev/null; then
        version=$(wget -qO- "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null | grep '"tag_name"' | head -1 | cut -d '"' -f 4)
    fi
    if [[ -z "$version" ]]; then
        echo "v1.0.0"
    else
        echo "$version"
    fi
}

PLATFORM=$(detect_platform)
VERSION=$(get_latest_version)
BINARY_NAME="bunradio-${PLATFORM}"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${BINARY_NAME}"

# En Windows, agregar .exe
if [[ "$PLATFORM" == windows-* ]]; then
    BINARY_NAME="${BINARY_NAME}.exe"
    DOWNLOAD_URL="${DOWNLOAD_URL}.exe"
fi

echo "  Plataforma: ${CYAN}${PLATFORM}${NC}"
echo "  Version:    ${CYAN}${VERSION}${NC}"
echo "  Instalar en: ${CYAN}${INSTALL_DIR}${NC}"
echo ""

# Verificar dependencias
echo "  Verificando dependencias..."
if ! command -v curl &> /dev/null && ! command -v wget &> /dev/null; then
    echo "  ${RED}[ERROR] Se requiere curl o wget${NC}"
    echo "  Instala curl:"
    echo "    - Ubuntu/Debian: sudo apt install curl"
    echo "    - Termux: pkg install curl"
    echo "    - macOS: xcode-select --install"
    exit 1
fi
echo "  ${GREEN}[OK] curl/wget disponible${NC}"

# Detectar si necesita sudo para instalar en /usr/local
INSTALL_CMD="mkdir -p"
SUDO=""
if [[ "$INSTALL_DIR" == /usr/* ]] || [[ "$INSTALL_DIR" == /opt/* ]]; then
    if [ "$(id -u)" -ne 0 ]; then
        SUDO="sudo"
        echo "  ${YELLOW}[INFO] Se usara sudo para instalar en ${INSTALL_DIR}${NC}"
    fi
fi

# Crear directorio
$SUDO $INSTALL_CMD "$INSTALL_DIR" 2>/dev/null || mkdir -p "$INSTALL_DIR"

# Descargar binario
echo ""
echo "  Descargando ${BINARY_NAME}..."

if command -v curl &> /dev/null; then
    if curl -fsSL "$DOWNLOAD_URL" -o "$INSTALL_DIR/bunradio" 2>/dev/null; then
        echo "  ${GREEN}[OK] Descarga completada${NC}"
    else
        echo "  ${RED}[ERROR] No se pudo descargar el binario${NC}"
        echo "  URL: ${DOWNLOAD_URL}"
        echo ""
        echo "  Verifica:"
        echo "    1. Tu conexion a internet"
        echo "    2. Que la version ${VERSION} exista"
        echo "    3. Que tu plataforma sea compatible: ${PLATFORM}"
        exit 1
    fi
elif command -v wget &> /dev/null; then
    if wget -q "$DOWNLOAD_URL" -O "$INSTALL_DIR/bunradio" 2>/dev/null; then
        echo "  ${GREEN}[OK] Descarga completada${NC}"
    else
        echo "  ${RED}[ERROR] No se pudo descargar el binario${NC}"
        echo "  URL: ${DOWNLOAD_URL}"
        exit 1
    fi
fi

# Hacer ejecutable
chmod +x "$INSTALL_DIR/bunradio" 2>/dev/null || true
echo "  ${GREEN}[OK] Permisos establecidos${NC}"

# Verificar binario
echo ""
echo "  Verificando binario..."
BIN_OK=false
if "$INSTALL_DIR/bunradio" --version &>/dev/null; then
    BIN_OK=true
elif "$INSTALL_DIR/bunradio" --help &>/dev/null; then
    BIN_OK=true
fi

if [ "$BIN_OK" = true ]; then
    echo "  ${GREEN}[OK] Binario verificado${NC}"
else
    # Algunos binarios no tienen flags, verificar que existe y tiene tamano
    if [ -f "$INSTALL_DIR/bunradio" ] && [ -s "$INSTALL_DIR/bunradio" ]; then
        echo "  ${GREEN}[OK] Binario listo ($(du -h "$INSTALL_DIR/bunradio" | cut -f1))${NC}"
    else
        echo "  ${RED}[ERROR] El binario parece corrupto${NC}"
        exit 1
    fi
fi

# Agregar al PATH
UPDATED_PATH=false
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo ""
    echo "  Configurando PATH..."
    
    SHELL_RC=""
    if [[ -n "$BASH_VERSION" ]]; then
        SHELL_RC="$HOME/.bashrc"
    elif [[ -n "$ZSH_VERSION" ]]; then
        SHELL_RC="$HOME/.zshrc"
    elif [ -f "$HOME/.bashrc" ]; then
        SHELL_RC="$HOME/.bashrc"
    elif [ -f "$HOME/.profile" ]; then
        SHELL_RC="$HOME/.profile"
    fi
    
    if [[ -n "$SHELL_RC" ]]; then
        # No duplicar si ya esta
        if ! grep -q "$INSTALL_DIR" "$SHELL_RC" 2>/dev/null; then
            echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$SHELL_RC"
            echo "  ${GREEN}[OK] PATH actualizado en ${SHELL_RC}${NC}"
            UPDATED_PATH=true
        else
            echo "  ${GREEN}[OK] PATH ya configurado en ${SHELL_RC}${NC}"
        fi
    fi
fi

echo ""
echo "  ============================================"
echo "        INSTALADO CORRECTAMENTE              "
echo "  ============================================"
echo ""
echo "  Ejecuta tu radio con:"
echo ""
echo "    ${CYAN}bunradio${NC}"
echo ""
echo "  O directamente:"
echo ""
echo "    ${CYAN}$INSTALL_DIR/bunradio${NC}"
echo ""
if [ "$UPDATED_PATH" = true ]; then
    echo "  ${YELLOW}[IMPORTANTE] Reinicia tu terminal o ejecuta:${NC}"
    echo "    ${CYAN}source ${SHELL_RC}${NC}"
    echo ""
fi
echo "  Para crear tu radio:"
echo ""
echo "    ${CYAN}mkdir -p ~/musica${NC}"
echo "    ${CYAN}cp *.mp3 ~/musica/${NC}"
echo "    ${CYAN}bunradio${NC}"
echo ""
echo "  La primera ejecucion:"
echo "    - Genera una stream key unica"
echo "    - Auto-detecta musica en ./musica"
echo "    - Muestra las instrucciones de conexion"
echo ""
echo "  Links:"
echo "    Stream:  http://localhost:808/stream"
echo "    Panel:   http://localhost:808/admin"
echo "    OBS:     rtmp://localhost:1935/live"
echo ""
echo "  Documentacion: https://github.com/${REPO}"
echo ""
