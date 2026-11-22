# Servidor de avisos de Partida

Express y `web-push` con claves VAPID.

## Ejecutar en local

```bash
npm install
npm run keys   # solo la primera vez: crea .env (no lo subas a Git)
npm start
npm test
```

## Rutas (`/api`)

| Ruta | Uso |
| --- | --- |
| `GET /health` | Estado del servidor |
| `POST /subscribe` | Registra un dispositivo y sus preferencias; da la bienvenida |
| `POST /unsubscribe` | Lo da de baja |
| `POST /test` | Aviso de prueba a ese dispositivo |
| `POST /reminders` y `/reminders/cancel` | Recordatorio de un juego, solo a ese dispositivo |
| `POST /library` | Aviso al guardar, mover o eliminar un juego: `gameId` y `action` (`wish`, `playing`, `done`, `removed`) |
| `POST /library/sync` | Reconstruye la biblioteca y los recordatorios del dispositivo, sin avisar |
| `POST /push` (token) | Aviso personalizado a todos: `title`, `body`, `url` |
| `POST /jobs/new-game` (token) | Anuncia `gameId` como nuevo a quienes siguen su género |
| `POST /jobs/weekly` (token) | Juego de la semana: `gameId` |
| `POST /jobs/release` (token) | Simula que `gameId` ya salió y avisa a quienes lo guardaron |
| `POST /jobs/run` (token) | Envía recordatorios vencidos y busca juegos nuevos |

Las rutas con token necesitan `Authorization: Bearer ADMIN_TOKEN`. En PowerShell:

```powershell
$token = ((Get-Content .env) -match '^ADMIN_TOKEN=')[0].Split('=')[1]
Invoke-RestMethod http://localhost:3000/api/jobs/new-game -Method Post -ContentType 'application/json' `
  -Headers @{ Authorization = "Bearer $token" } -Body '{"gameId": 655}'
```

## Desplegar en Render

1. Sube este proyecto a GitHub. Comprueba que `.env` no aparece en el repositorio.
2. En Render: **New > Blueprint** y elige el repositorio (usa `render.yaml`).
3. Copia los valores de tu `.env`. En `VAPID_SUBJECT` y `ALLOWED_ORIGINS` pon la URL de tu app,
   sin barra final.

El plan gratuito se duerme sin uso y pierde los datos al reiniciarse. Los dispositivos y sus
recordatorios se vuelven a registrar al abrir la app; hasta entonces no se envían. Para despertarlo y lanzar
los avisos automáticos, programa una llamada periódica a `/api/jobs/run`.
