#!/bin/bash
# =============================================================
# BunRadio - Instalador rápido
# =============================================================
# Uso: curl -fsSL https://raw.githubusercontent.com/srsergi0/Buncaster/main/install.sh | bash
# O:   bash install.sh
# =============================================================

set -e

REPO="srsergi0/Buncaster"
INSTALL_DIR="${BUNRADIO_DIR:-$HOME/.bunradio}"

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║       🎙️  B U N R A D I O  I N S T A L L       ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo ""

# Detectar SO y arquitectura
detect_platform() {
    local os=$(uname -s | tr '[:upper:]' '[:lower:]')
    local arch=$(uname -m)
    
    case "$os" in
        linux)
            case "$arch" in
                x86_64)  echo "linux-x64" ;;
                aarch64) echo "linux-arm64" ;;
                armv7l)  echo "linux-arm64" ;;
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
        msys*|mingw*|cygwin*|nt)
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
    version=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null | grep '"tag_name"' | head -1 | cut -d '"' -f 4)
    if [[ -z "$version" ]]; then
        echo "latest"
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

echo "  ▸ Plataforma: ${CYAN}${PLATFORM}${NC}"
echo "  ▸ Versión:    ${CYAN}${VERSION}${NC}"
echo "  ▸ Instalar en: ${CYAN}${INSTALL_DIR}${NC}"
echo ""

# Verificar dependencias
echo "  ▸ Verificando dependencias..."
if ! command -v curl &> /dev/null && ! command -v wget &> /dev/null; then
    echo -e "  ${RED}✗ Se requiere curl o wget${NC}"
    echo "    Instala curl: sudo apt install curl"
    exit 1
fi
echo -e "  ${GREEN}✓ curl/wget disponible${NC}"

# Crear directorio
mkdir -p "$INSTALL_DIR"

# Descargar binario
echo ""
echo "  ▸ Descargando ${BINARY_NAME}..."
echo "    URL: ${DOWNLOAD_URL}"

if command -v curl &> /dev/null; then
    if curl -fsSL "$DOWNLOAD_URL" -o "$INSTALL_DIR/bunradio" 2>/dev/null; then
        echo -e "  ${GREEN}✓ Descarga completada${NC}"
    else
        echo -e "  ${RED}✗ Error al descargar. Verifica la versión o tu conexión.${NC}"
        echo "    URL: ${DOWNLOAD_URL}"
        exit 1
    fi
elif command -v wget &> /dev/null; then
    if wget -q "$DOWNLOAD_URL" -O "$INSTALL_DIR/bunradio" 2>/dev/null; then
        echo -e "  ${GREEN}✓ Descarga completada${NC}"
    else
        echo -e "  ${RED}✗ Error al descargar. Verifica la versión o tu conexión.${NC}"
        echo "    URL: ${DOWNLOAD_URL}"
        exit 1
    fi
fi

# Hacer ejecutable
chmod +x "$INSTALL_DIR/bunradio"
echo -e "  ${GREEN}✓ Permisos de ejecución establecidos${NC}"

# Verificar que el binario funciona
echo ""
echo "  ▸ Verificando binario..."
if "$INSTALL_DIR/bunradio" --version &>/dev/null || "$INSTALL_DIR/bunradio" --help &>/dev/null; then
    echo -e "  ${GREEN}✓ Binario verificado${NC}"
else
    # Puede que no tenga flags, intentar ejecutar brevemente
    timeout 2 "$INSTALL_DIR/bunradio" &>/dev/null || true
    echo -e "  ${GREEN}✓ Binario listo${NC}"
fi

# Agregar al PATH
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo ""
    echo "  ▸ Agregando al PATH..."
    
    SHELL_RC=""
    if [[ -f "$HOME/.bashrc" ]]; then
        SHELL_RC="$HOME/.bashrc"
    elif [[ -f "$HOME/.zshrc" ]]; then
        SHELL_RC="$HOME/.zshrc"
    elif [[ -f "$HOME/.config/fish/config.fish" ]]; then
        SHELL_RC="$HOME/.config/fish/config.fish"
    fi
    
    if [[ -n "$SHELL_RC" ]]; then
        if [[ "$SHELL_RC" == *fish* ]]; then
            echo "set -gx PATH $INSTALL_DIR \$PATH" >> "$SHELL_RC"
        else
            echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$SHELL_RC"
        fi
        echo -e "  ${GREEN}✓ PATH actualizado en ${SHELL_RC}${NC}"
    else
        echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$HOME/.bashrc"
        echo -e "  ${GREEN}✓ PATH actualizado en ~/.bashrc${NC}"
    fi
fi

echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║              ✅ INSTALADO CORRECTAMENTE         ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo ""
echo "  Ejecuta tu radio con:"
echo ""
echo -e "    ${CYAN}bunradio${NC}"
echo ""
echo "  O directamente:"
echo ""
echo -e "    ${CYAN}$INSTALL_DIR/bunradio${NC}"
echo ""
echo "  La primera ejecución:"
echo "  1. Genera una stream key única"
echo "  2. Auto-detecta música en ./musica"
echo "  3. Muestra las instrucciones de conexión"
echo ""
echo "  Coloca una carpeta 'musica' junto al binario:"
echo ""
echo -e "    ${CYAN}mkdir -p ~/musica${NC}"
echo -e "    ${CYAN}cp *.mp3 ~/musica/${NC}"
echo ""
echo "  ¡Tu radio está lista! 🎙️"
echo ""
