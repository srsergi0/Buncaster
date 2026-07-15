#!/bin/bash
# =============================================================
# BunRadio - Instalador rapido
# =============================================================
# Uso: curl -fsSL https://raw.githubusercontent.com/srsergi0/Buncaster/main/install.sh | bash
# O:   bash install.sh
# Soporta: Linux, macOS, Windows (WSL/Git Bash), Termux (Android)
# =============================================================

set -e

REPO="srsergi0/Buncaster"
INSTALL_DIR="${BUNRADIO_DIR:-$HOME/.bunradio}"

# Colores ANSI
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
printf "${CYAN}  ============================================${NC}\n"
printf "${CYAN}         B U N R A D I O   I N S T A L L     ${NC}\n"
printf "${CYAN}  ============================================${NC}\n"
echo ""

# Detectar Termux
IS_TERMUX=false
if [ -d "/data/data/com.termux" ] || [ "$TERMUX_VERSION" ]; then
    IS_TERMUX=true
fi

# En Termux, instalar desde codigo fuente con Bun
if [ "$IS_TERMUX" = true ]; then
    printf "  ${YELLOW}[TERMUX] Instalando desde codigo fuente...${NC}\n"
    echo ""
    
    # Verificar que git este instalado
    if ! command -v git &> /dev/null; then
        printf "  ${BOLD}Instalando git...${NC}\n"
        pkg install git -y
    fi
    printf "  ${GREEN}[OK] git disponible${NC}\n"
    
    # Instalar Bun parcheado para Termux (bd-loser/bun-termux)
    if ! command -v bun &> /dev/null; then
        printf "  ${BOLD}Instalando Bun (build Termux parcheado)...${NC}\n"
        BUN_DEB_URL="https://github.com/bd-loser/bun-termux/releases/latest/download/bun_aarch64.deb"
        curl -fsSL "$BUN_DEB_URL" -o "$TMPDIR/bun.deb" && \
        dpkg -i "$TMPDIR/bun.deb" && rm "$TMPDIR/bun.deb"
    fi
    printf "  ${GREEN}[OK] Bun disponible: $(bun --version)${NC}\n"
    
    # Clonar repositorio
    REPO_DIR="$HOME/bunradio"
    if [ -d "$REPO_DIR" ]; then
        rm -rf "$REPO_DIR"
    fi
    
    printf "  ${BOLD}Clonando repositorio...${NC}\n"
    git clone --depth 1 "https://github.com/${REPO}.git" "$REPO_DIR"
    
    # Instalar dependencias
    printf "  ${BOLD}Instalando dependencias...${NC}\n"
    cd "$REPO_DIR"
    bun install
    
    # Crear script launcher
    mkdir -p "$INSTALL_DIR"
    cat > "$INSTALL_DIR/bunradio" << 'LAUNCHER'
#!/bin/bash
cd ~/bunradio && bun run start
LAUNCHER
    chmod +x "$INSTALL_DIR/bunradio"
    
    # Agregar al PATH si no esta
    if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
        echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$HOME/.bashrc"
    fi
    
    printf "  ${GREEN}[OK] Instalado en ${REPO_DIR}${NC}\n"
    
    echo ""
    printf "${GREEN}  ============================================${NC}\n"
    printf "${GREEN}        INSTALADO CORRECTAMENTE (TERMUX)     ${NC}\n"
    printf "${GREEN}  ============================================${NC}\n"
    echo ""
    echo "  Ejecuta tu radio con:"
    echo ""
    printf "    ${CYAN}source ~/.bashrc${NC}\n"
    printf "    ${CYAN}bunradio${NC}\n"
    echo ""
    echo "  O directamente:"
    echo ""
    printf "    ${CYAN}cd ~/bunradio && bun run start${NC}\n"
    echo ""
    echo "  Para crear tu radio:"
    echo ""
    printf "    ${CYAN}mkdir -p ~/musica${NC}\n"
    printf "    ${CYAN}cp *.mp3 ~/musica/${NC}\n"
    printf "    ${CYAN}bunradio${NC}\n"
    echo ""
    echo "  Links:"
    echo "    Stream:  http://localhost:808/stream"
    echo "    Panel:   http://localhost:808/admin"
    echo "    OBS:     rtmp://localhost:1935/live"
    echo ""
    exit 0
fi

# =============================================================
# Linux, macOS, Windows (WSL/Git Bash)
# =============================================================

# Detectar SO y arquitectura
detect_platform() {
    local os=$(uname -s | tr '[:upper:]' '[:lower:]')
    local arch=$(uname -m)
    
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

# Obtener la ultima version desde GitHub API
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

printf "  ${BOLD}Plataforma:${NC}  ${CYAN}%s${NC}\n" "$PLATFORM"
printf "  ${BOLD}Version:${NC}     ${CYAN}%s${NC}\n" "$VERSION"
printf "  ${BOLD}Instalar en:${NC} ${CYAN}%s${NC}\n" "$INSTALL_DIR"
echo ""

# Verificar dependencias
printf "  ${BOLD}Verificando dependencias...${NC}\n"
if ! command -v curl &> /dev/null && ! command -v wget &> /dev/null; then
    printf "  ${RED}[ERROR] Se requiere curl o wget${NC}\n"
    echo "  Instala curl:"
    echo "    - Ubuntu/Debian: sudo apt install curl"
    echo "    - macOS: xcode-select --install"
    exit 1
fi
printf "  ${GREEN}[OK] curl/wget disponible${NC}\n"

# Detectar si necesita sudo
SUDO=""
if [[ "$INSTALL_DIR" == /usr/* ]] || [[ "$INSTALL_DIR" == /opt/* ]]; then
    if [ "$(id -u)" -ne 0 ]; then
        SUDO="sudo"
        printf "  ${YELLOW}[INFO] Se usara sudo para instalar en %s${NC}\n" "$INSTALL_DIR"
    fi
fi

# Crear directorio
$SUDO mkdir -p "$INSTALL_DIR" 2>/dev/null || mkdir -p "$INSTALL_DIR"

# Descargar binario
echo ""
printf "  ${BOLD}Descargando %s...${NC}\n" "$BINARY_NAME"

if command -v curl &> /dev/null; then
    if curl -fsSL "$DOWNLOAD_URL" -o "$INSTALL_DIR/bunradio" 2>/dev/null; then
        printf "  ${GREEN}[OK] Descarga completada${NC}\n"
    else
        printf "  ${RED}[ERROR] No se pudo descargar el binario${NC}\n"
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
        printf "  ${GREEN}[OK] Descarga completada${NC}\n"
    else
        printf "  ${RED}[ERROR] No se pudo descargar el binario${NC}\n"
        echo "  URL: ${DOWNLOAD_URL}"
        exit 1
    fi
fi

# Hacer ejecutable
chmod +x "$INSTALL_DIR/bunradio" 2>/dev/null || true
printf "  ${GREEN}[OK] Permisos establecidos${NC}\n"

# Verificar binario
echo ""
printf "  ${BOLD}Verificando binario...${NC}\n"
BIN_SIZE=$(du -h "$INSTALL_DIR/bunradio" | cut -f1)
if [ -f "$INSTALL_DIR/bunradio" ] && [ -s "$INSTALL_DIR/bunradio" ]; then
    printf "  ${GREEN}[OK] Binario listo (%s)${NC}\n" "$BIN_SIZE"
else
    printf "  ${RED}[ERROR] El binario parece corrupto${NC}\n"
    exit 1
fi

# Agregar al PATH
UPDATED_PATH=false
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo ""
    printf "  ${BOLD}Configurando PATH...${NC}\n"
    
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
        if ! grep -q "$INSTALL_DIR" "$SHELL_RC" 2>/dev/null; then
            echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$SHELL_RC"
            printf "  ${GREEN}[OK] PATH actualizado en %s${NC}\n" "$SHELL_RC"
            UPDATED_PATH=true
        else
            printf "  ${GREEN}[OK] PATH ya configurado${NC}\n"
        fi
    fi
fi

echo ""
printf "${GREEN}  ============================================${NC}\n"
printf "${GREEN}        INSTALADO CORRECTAMENTE              ${NC}\n"
printf "${GREEN}  ============================================${NC}\n"
echo ""
echo "  Ejecuta tu radio con:"
echo ""
printf "    ${CYAN}bunradio${NC}\n"
echo ""
echo "  O directamente:"
echo ""
printf "    ${CYAN}%s/bunradio${NC}\n" "$INSTALL_DIR"
echo ""
if [ "$UPDATED_PATH" = true ]; then
    printf "  ${YELLOW}[IMPORTANTE] Reinicia tu terminal o ejecuta:${NC}\n"
    printf "    ${CYAN}source %s${NC}\n" "$SHELL_RC"
    echo ""
fi
echo "  Para crear tu radio:"
echo ""
printf "    ${CYAN}mkdir -p ~/musica${NC}\n"
printf "    ${CYAN}cp *.mp3 ~/musica/${NC}\n"
printf "    ${CYAN}bunradio${NC}\n"
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
