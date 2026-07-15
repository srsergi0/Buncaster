#!/bin/bash
# =============================================================
# BunRadio - Instalador rápido
# =============================================================
# Uso: curl -fsSL https://raw.githubusercontent.com/.../install.sh | bash
# O:   bash install.sh
# =============================================================

set -e

REPO="bunradio/bunradio"
VERSION="latest"
INSTALL_DIR="${BUNRADIO_DIR:-$HOME/.bunradio}"

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
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

PLATFORM=$(detect_platform)
BINARY_NAME="bunradio-${PLATFORM}"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${BINARY_NAME}"

# En Windows, agregar .exe
if [[ "$PLATFORM" == windows-* ]]; then
    BINARY_NAME="${BINARY_NAME}.exe"
    DOWNLOAD_URL="${DOWNLOAD_URL}.exe"
fi

echo "  ▸ Plataforma detectada: ${YELLOW}${PLATFORM}${NC}"
echo "  ▸ Directorio de instalación: ${YELLOW}${INSTALL_DIR}${NC}"
echo ""

# Crear directorio
mkdir -p "$INSTALL_DIR"

# Descargar binario
echo "  ▸ Descargando ${BINARY_NAME}..."
if command -v curl &> /dev/null; then
    curl -fsSL "$DOWNLOAD_URL" -o "$INSTALL_DIR/bunradio"
elif command -v wget &> /dev/null; then
    wget -q "$DOWNLOAD_URL" -O "$INSTALL_DIR/bunradio"
else
    echo -e "  ${RED}✗ Se requiere curl o wget${NC}"
    exit 1
fi

# Hacer ejecutable (no en Windows)
if [[ "$PLATFORM" != windows-* ]]; then
    chmod +x "$INSTALL_DIR/bunradio"
fi

# Agregar al PATH si no está
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo ""
    echo "  ▸ Agregando al PATH..."
    
    # Detectar shell
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
        echo "    Reinicia tu terminal o ejecuta: source ${SHELL_RC}"
    else
        echo -e "  ${YELLOW}⚠ Agrega manualmente a tu PATH: ${INSTALL_DIR}${NC}"
    fi
fi

echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║              ✅ INSTALADO CORRECTAMENTE         ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo ""
echo "  Ejecuta tu radio con:"
echo ""
echo "    bunradio"
echo ""
echo "  O directamente:"
echo ""
echo "    $INSTALL_DIR/bunradio"
echo ""
echo "  La primera ejecución generará una stream key única."
echo "  Coloca una carpeta 'musica' junto al binario para tener fallback."
echo ""
echo "  ¡Tu radio está lista!"
echo ""
