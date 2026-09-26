# Backend local del MVP

Este servidor es la primera capa de conexión de Climainsta. Actualmente incluye:

- `/` para servir el prototipo.
- `/health` para comprobar el estado de las conexiones.
- `GET /api/notices` para consultar avisos en memoria.
- `POST /api/notices` para crear avisos.
- `POST /api/telegram/webhook` como entrada preparada para respuestas del bot.

Los avisos todavía se guardan en memoria para las pruebas. El siguiente paso será sustituirlos por una base de datos y añadir el envío real de Telegram, Stripe y correo.

Para ejecutarlo localmente:

```text
node work/server/server.js
```
