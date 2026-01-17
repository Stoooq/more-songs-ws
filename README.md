# more-songs-ws

Samodzielny serwer WebSocket (socket.io) dla projektu **more-songs**.

## Lokalne uruchomienie

1. `cp .env.example .env` i ustaw `DATABASE_URL`.
2. `npm install`
3. `npm run server`

Domyślnie słucha na porcie z `PORT` (fallback: `3001`).

## Render (deploy)

Render wspiera WebSockety w usługach typu **Web Service**.

1. Utwórz **New + → Web Service** i podepnij repozytorium.
2. Ustaw **Root Directory** na `more-songs-ws`.
3. Ustaw komendy:
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
4. Ustaw zmienne środowiskowe:
   - `DATABASE_URL` (wymagane)
   - `PORT` (Render zwykle ustawia automatycznie; kod czyta `process.env.PORT`)

Po deployu Render da Ci domenę `*.onrender.com`; możesz też dodać własną domenę w ustawieniach serwisu.
