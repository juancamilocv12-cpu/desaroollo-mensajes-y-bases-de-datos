# WhatsApp Cloud API Campaign Engine

Servicio HTTP para automatizaciones estilo Make con:

- Envio de templates
- Envio de multimedia (image, video, audio, document, sticker)
- Envio de texto
- Carga de base en Excel para campanas masivas
- Programacion por hora de inicio (`startAt`)
- Anti-spam por timing, lotes, pausas y jitter
- Reintentos automaticos
- Webhook de Meta para eventos
- Dashboard basico de estado y logs

## 1) Requisitos

- Node.js 18+
- `phone_number_id` de WhatsApp Cloud API
- Token de Meta con permisos para mensajes
- Plantillas aprobadas en tu WABA

## 2) Instalacion

```bash
npm install
cp .env.example .env
```

## 3) Variables de entorno

```env
PORT=3000
WHATSAPP_API_VERSION=v21.0
WHATSAPP_PHONE_NUMBER_ID=1234567890
WHATSAPP_ACCESS_TOKEN=EAAG...
WHATSAPP_BUSINESS_ACCOUNT_ID=1234567890
WHATSAPP_WEBHOOK_VERIFY_TOKEN=mi_token_de_verificacion
```

## 4) Arranque

```bash
npm run dev
```

## 5) Endpoints principales

- `GET /health`
- `GET /platform`
- `GET /dashboard` (redirige a `/platform`)
- `GET /logs?limit=200`
- `GET /campaigns`
- `GET /campaigns/:id`
- `GET /templates?businessAccountId=...`
- `GET /templates/:name/requirements`
- `POST /send-template`
- `POST /send-template-smart`
- `POST /send-media`
- `POST /send-text`
- `POST /send-message` (mensaje generico tipo raw para interactive/location/reaction/contacts y mas)
- `POST /messages/mark-read`
- `POST /media/upload`
- `POST /campaigns/from-excel`
- `GET /webhook` (verificacion)
- `POST /webhook` (eventos)

## 6) Plataforma web operativa

Abre:

`http://localhost:3000/platform`

Desde esa vista puedes:

- Enviar a un solo numero (text/media/template/template-smart)
- Subir archivos a Meta y obtener `media_id`
- Consultar requisitos de una template y validar `templateInputs`
- Usar constructor visual de parametros de template (sin escribir JSON)
- Crear campanas desde Excel con anti-spam y programacion
- Monitorear campanas y logs en vivo

## 7) Envio template

`POST /send-template`

```json
{
  "to": "573001234567",
  "templateName": "mi_template",
  "languageCode": "es",
  "components": [
    {
      "type": "body",
      "parameters": [
        { "type": "text", "text": "Juan" }
      ]
    }
  ]
}
```

## 8) Envio multimedia

`POST /send-media`

```json
{
  "to": "573001234567",
  "mediaType": "image",
  "link": "https://mi-cdn.com/oferta.jpg",
  "caption": "Promocion de hoy"
}
```

Tambien puedes usar `mediaId` en vez de `link`.

## 9) Subir media para obtener media_id

`POST /media/upload` (multipart/form-data)

Campo requerido:

- `file`: archivo binario

Respuesta esperada:

```json
{
  "ok": true,
  "mediaId": "1234567890"
}
```

## 10) Envio template con validacion de requisitos

`POST /send-template-smart`

Este endpoint consulta la template en Meta, valida cantidades/tipos (body, header, buttons dinamicos) y solo luego envIa.

```json
{
  "to": "573001234567",
  "templateName": "recordatorio_pago",
  "languageCode": "es",
  "templateInputs": {
    "header": { "type": "image", "mediaId": "123456" },
    "body": ["Juan", "F123"],
    "buttons": [
      { "index": 0, "subType": "url", "text": "track-001" }
    ]
  }
}
```

## 11) Campana desde Excel (anti-spam + programacion)

Puedes enviar el archivo por multipart (`file`) o usar `filePath`.

### Opcion A: multipart

```bash
curl -X POST http://localhost:3000/campaigns/from-excel \
  -F "file=@/ruta/clientes.xlsx" \
  -F 'phoneColumn=telefono' \
  -F 'startAt=2026-04-01T13:00:00-05:00' \
  -F 'antiSpam={"timingMs":1400,"batchSize":30,"batchPauseMs":25000,"maxRetries":2,"retryDelayMs":3000,"jitterMs":500}' \
  -F 'message={"type":"template","templateName":"recordatorio_pago","languageCode":"es","components":[{"type":"body","parameters":[{"type":"text","text":"{{nombre}}"},{"type":"text","text":"{{factura}}"}]}]}'
```

### Opcion B: JSON con ruta local

```json
{
  "filePath": "/Users/tu_usuario/clientes.xlsx",
  "sheetName": "Hoja1",
  "phoneColumn": "telefono",
  "startAt": "2026-04-01T13:00:00-05:00",
  "antiSpam": {
    "timingMs": 1400,
    "batchSize": 30,
    "batchPauseMs": 25000,
    "maxRetries": 2,
    "retryDelayMs": 3000,
    "jitterMs": 500
  },
  "message": {
    "type": "media",
    "mediaType": "image",
    "link": "https://mi-cdn.com/banner-{{segmento}}.jpg",
    "caption": "Hola {{nombre}}, tenemos una oferta para ti"
  }
}
```

Placeholders tipo `{{nombre}}` se reemplazan con columnas del Excel.

## 12) Webhook de Meta

### Verificacion

Meta llama:

`GET /webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`

El token debe coincidir con `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.

### Eventos

Meta enviara eventos a:

`POST /webhook`

Se guardan en logs internos y puedes verlos en `/logs` y `/dashboard`.

## 13) Endpoint generico para tipos avanzados

`POST /send-message`

Permite enviar estructuras raw compatibles con la API oficial, por ejemplo:

- `interactive` (listas/botones)
- `reaction`
- `location`
- `contacts`
- cualquier otro tipo soportado por Message API

Ejemplo:

```json
{
  "to": "573001234567",
  "type": "reaction",
  "reaction": {
    "message_id": "wamid.HBg...",
    "emoji": "👍"
  }
}
```

## 14) Marcar mensaje como leido

`POST /messages/mark-read`

```json
{
  "messageId": "wamid.HBg..."
}
```

## 15) Recomendaciones valiosas de la API oficial

Basado en la documentacion de Message API:

- Usa tokens de sistema de larga duracion para produccion y evita tokens de 24h.
- Valida permisos `whatsapp_business_messaging` y `whatsapp_business_management`.
- Para consultas de colecciones, contempla paginacion (`paging.next` / `paging.previous`).
- Aprovecha estados/confirmaciones via webhook para trazabilidad de entrega y lectura.
- Estandariza `apiVersion` por entorno (dev/stage/prod) para upgrades controlados.

Referencia:

- https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api

## 16) Recomendaciones anti-spam

- Inicia con `timingMs` entre 1200 y 2500 ms.
- Usa `batchSize` de 20 a 40 y `batchPauseMs` de 15 a 45 segundos.
- Deja `jitterMs` en 300 a 800 para variar intervalos.
- Valida que tus destinatarios tengan opt-in y usa solo templates aprobadas.
