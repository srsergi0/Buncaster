FROM oven/bun:alpine

# Instalar FFmpeg y limpiar la caché de apk para reducir el tamaño al máximo
RUN apk add --no-cache ffmpeg

# Directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias
COPY package.json bun.lock tsconfig.json ./

# Instalar únicamente las dependencias de producción para minimizar tamaño
RUN bun install --production --frozen-lockfile

# Copiar el código fuente de la aplicación
COPY src ./src

# Exponer los puertos correspondientes (HTTP: 4321 y RTMP: 1935 por defecto)
EXPOSE 4321
EXPOSE 1935

# Definir entorno de producción
ENV NODE_ENV=production

# Ejecutar el servidor de radio
CMD ["bun", "run", "src/index-rtmp.ts"]
