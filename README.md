# Rupu, servidor

Servidor del prototipo de Rupu, una app de orientación en la ciudad para personas con discapacidad intelectual.
Maneja cuentas, vínculo entre persona usuaria y acompañante, lugares y rutas guardadas, viajes en vivo,
pedidos de ayuda, niveles de autonomía, hitos automáticos (OpenStreetMap) y planificador de micro y metro (GTFS).

El código está en `server/`. Requiere Node 22.13 o superior y no tiene dependencias que instalar.

    cd server
    npm test                          # prueba todos los flujos
    ADMIN_TOKEN=un-secreto npm start  # parte en el puerto 8080

## Variables

- `ADMIN_TOKEN`: clave del superadmin. Se usa en el panel web `/admin` y en la entrada "Soy superadmin" de la app.
- `DATA_DIR`: carpeta de la base de datos y del GTFS. Debe estar en un volumen para no perder los datos.
- `GTFS_URL`: dirección del GTFS de Red (DTPM). Al partir, el servidor lo descarga y lo convierte una sola vez.
- `PRICE_CLP`: precio mensual que se muestra (4990 por defecto).
- `PORT`: puerto (Railway lo define solo).

Sin GTFS el servidor funciona igual, pero solo ofrece rutas a pie.

## Despliegue en Railway

1. New Project, Deploy from GitHub repo, elegir este repositorio.
2. En Settings del servicio, Root Directory: `server`. Railway usa el `Dockerfile`.
3. Agregar un volumen montado en `/data`.
4. En Variables: `ADMIN_TOKEN` (una clave propia) y, cuando esté disponible, `GTFS_URL`.
5. En Settings, Networking, Generate Domain. Esa dirección es la que se escribe en la primera pantalla de la app.

Para comprobarlo: abrir `https://TU-DOMINIO/health` debe responder `{"ok":true,...}`.

## Qué está simulado

El cobro de la suscripción (se activa sin pagar) y las notificaciones con la app cerrada.
