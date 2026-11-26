# De KiWi a KyL Express: plan de traspaso

Este documento es para el programador que convierte **KiWi** en **KyL Express**, la marca y el negocio de Luis Espinoza. Está escrito al 26 de noviembre de 2026, en la rama `migracion-supabase`.

---

## 0. Situación legal (leer primero)

- El código de KiWi es de **Francisco Javier Campos Díaz**. El **26/11/2026** lo publicó bajo **Apache-2.0** en su repo público `sasasamaes/kiwi`, en el commit `1e44b33`. Este repo (`luisespinoza1212-arch/KiWicr`) es un fork de ese.
- Apache-2.0 permite usarlo, modificarlo y explotarlo comercialmente de forma **perpetua e irrevocable**, con estas condiciones:
  1. **Conservar** el `LICENSE` y los avisos de copyright existentes. Hay unos 600 encabezados que dicen *"Todos los derechos reservados"*: **no borrarlos**. El `LICENSE` Apache es el que rige.
  2. **Marcar los archivos modificados.** Alcanza con una línea, por ejemplo `// Modificado por KyL Express, 2026`, o con un archivo `NOTICE` que lo explique, además del historial de git.
  3. **No usar la marca "KiWi"** en nada que vea el público: nombre, logo, tiendas de apps, dominio o correos.
  4. Las apps que se distribuyan (Play Store, App Store) deben incluir una **copia de la licencia**, por ejemplo en una pantalla "Licencias de código abierto".
- Lo que se agregue encima es de KyL Express. Se puede poner un copyright propio en los archivos nuevos.
- **Luis es dueño de todas las cuentas** (GitHub, Supabase, Render, Vercel, Firebase, Google Cloud, tiendas de apps, dominio). El programador trabaja como colaborador invitado.

> Hay otro proyecto, `kyl-express` (repo aparte), que se escribió desde cero como alternativa. Es una app Next.js + Supabase más simple, sin apps nativas. No mezclar los dos sin una decisión explícita.

---

## 1. Qué ya está hecho en esta rama (`migracion-supabase`)

| Commit | Qué hace |
|---|---|
| `5a3dc61` | Las imágenes pasan de Cloudinary a **Supabase Storage** (bucket público `kiwi`). La cuenta de Didit se vuelve configurable (`DIDIT_WORKFLOW_ID`). Se permite `DB_STATEMENT_TIMEOUT_MS=off` para el pooler. |
| `197bb05` | **Verificación de identidad (KYC) manual** para repartidores: los documentos van al bucket **privado** `kyc-private` como refs `kyc://…`, el admin los ve con URLs firmadas de 10 minutos, y la cédula y la licencia se guardan cifradas (`KYC_FIELD_ENCRYPTION_KEY`). El botón de Didit solo aparece si está configurado. La app móvil del repartidor abre el formulario web. |
| `2514755` | La CSP de los tres `vercel.json` apunta al nuevo API, y se documenta el build de Render. |

**Infraestructura a nombre de Luis, creada y probada:**
- **Supabase**:
  - proyecto `healjpjjhyfpzywkvtsq` (us-east-1), hoy **pausado**
  - 70 migraciones de Prisma aplicadas y datos demo, con las contraseñas demo cambiadas
  - ⚠️ El plan gratis permite **2 proyectos activos**, y hoy ocupan ese lugar `kyl-express` e `innovaglassapp`. Para reactivar este hay que pausar otro o pasar a Pro.
- **Render**:
  - servicio `kiwi-api` → `https://kiwi-api-wpbv.onrender.com`, plan Starter, hoy **suspendido**
  - Root `api`
  - Build: `npm install --include=dev && npm run build`. El `--include=dev` hace falta porque `NODE_ENV=production` omite `@nestjs/cli`.
  - Start: `npm run start:prod`
  - Se verificó `/api/health` OK, login de admin OK y que las rutas protegidas devuelven 401.
- Las variables de Render están en un archivo privado de Luis (`render.env`), **fuera del repo**. Pedíselas a Luis por un canal seguro o generá las tuyas.

**Lo que no se hizo:** Vercel, el dominio, Firebase y Google Maps a nombre de Luis, y el cambio de marca.

---

## 2. Servicios: qué hay que crear a nombre de Luis

Ninguno requiere a Kiko: cada uno se configura con variables de entorno.

| Prioridad | Servicio | Variables | Estado |
|---|---|---|---|
| 🔴 | Supabase (DB + Storage) | `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`, `SUPABASE_KYC_BUCKET` | ✅ creado (pausado) |
| 🔴 | Render (API NestJS) | `JWT_SECRET`, `KYC_FIELD_ENCRYPTION_KEY`, `CORS_ORIGIN`/`CLIENT_URL`/`WEB_URL`/`DRIVER_URL`, `KYC_REQUIRED` | ✅ creado (suspendido) |
| 🔴 | Vercel (`apps/web`, `apps/client`, `apps/driver`) | `NEXT_PUBLIC_API_URL`, `VENTAS_ACCESS_KEY` (web), `NEXT_PUBLIC_ONVO_PUBLISHABLE_KEY` (client) | ⏳ por crear. Root Directory por app. Production Branch = la rama que corresponda. |
| 🔴 | Dominio | DNS de los subdominios | Luis tiene `kiwicr.express`; para KyL conviene uno nuevo |
| 🟡 | Firebase (push) | `FIREBASE_SERVICE_ACCOUNT` (API) + `NEXT_PUBLIC_FIREBASE_*` (web) | ⏳ |
| 🟡 | Google Maps | `GOOGLE_MAPS_API_KEY` | ⏳ |
| 🟡 | ONVO (tarjeta) | `ONVO_SECRET_KEY`, `ONVO_WEBHOOK_SECRET`, `NEXT_PUBLIC_ONVO_PUBLISHABLE_KEY` | ✅ la cuenta es de Luis. **No cambiar el webhook en ONVO hasta el día del corte**, porque hoy lo usa la producción de KiWi. |
| ⚪ | Didit, Sentry, PostHog, Stellar, Redis | `DIDIT_*`, `SENTRY_DSN`, `NEXT_PUBLIC_POSTHOG_*`, `STELLAR_*`, `REDIS_URL` | Opcionales: pueden quedar apagados |
| 🔴 | **Apps móviles** (Expo) | `EXPO_PUBLIC_API_URL`, etc. | ⏳ Ver sección 4 |

---

## 3. Cambio de marca KiWi → KyL

**Tamaño:** "kiwi" aparece unas 4.500 veces en 569 archivos, y `kiwicr.express` 86 veces. **No hace falta cambiar todo.** Hay que cambiar lo que **ve el público**:

1. **Textos** en `packages/i18n` (es/en): el nombre de la app, mensajes, correos y WhatsApp.
2. **Metadatos e íconos:** `<title>`, `manifest` de las PWA, favicons, splash screens e íconos de las apps nativas.
3. **Logo y colores:** la paleta `kiwi-*` de Tailwind y los componentes de `packages/ui`. Se puede mantener el nombre interno del token y cambiar solo sus valores, para no tocar cientos de clases.
4. **Dominios:** `kiwicr.express` en CORS (`api/src/main.ts`), CSP (`vercel.json`, `packages/ui/security-headers.cjs`), enlaces y `EXPO_PUBLIC_DRIVER_WEB_URL`.
5. **Identificadores de las apps móviles** (sección 4).

**Se puede dejar** lo interno que nadie ve: los paquetes `@kiwi/*`, los nombres de carpetas y variables. Renombrarlos es opcional y riesgoso.

**Diseño de referencia:** el proyecto `kyl-express` ya tiene el sistema visual de KyL (azul marino `#0b2545` + amarillo `#ffc61a`, letra Inter, íconos lucide). Luis tiene el logo final.

---

## 4. Apps móviles (Expo)

| App | Paquete actual | EAS projectId | Owner Expo |
|---|---|---|---|
| `apps/client-mobile` | `express.kiwicr.cliente` | `b345f7e8…` | `kiwicr` |
| `apps/driver-mobile` | `express.kiwicr.repartidor` | `d47fc4ab…` | `kiwicr` |
| `apps/merchant-mobile` | `express.kiwicr.negocios` | `c5b95050…` | `kiwicr` |

- La cuenta Expo `kiwicr` y las fichas publicadas en las tiendas **no son de Luis** y no se pueden transferir sin el dueño. **No hace falta transferirlas**: se publican como **apps nuevas de KyL**.
- Pasos:
  1. Crear una cuenta Expo de Luis.
  2. Cambiar `owner`, borrar el `projectId` y correr `eas init`.
  3. Paquetes nuevos, por ejemplo `express.kyl.repartidor`.
  4. Cuentas de desarrollador de Luis: Google Play (USD 25, un solo pago) y Apple (USD 99 al año).
- Agregar la pantalla de licencias (Apache-2.0).

---

## 5. Datos

Luis prefiere **empezar con la base limpia** y volver a registrar a mano a los comercios y repartidores, que son pocos. No hace falta migrar datos de la producción de Kiko.

Antes de abrir al público:
- borrar o desactivar los usuarios demo (`luis@`, `juan@`, `fran@`, `joel@`, `maria@`, `carlos@`, `ana@`, `admin@kiwi.app`)
- crear el admin real
- cargar los barrios y precios de Nicoya

---

## 6. Ideas del proyecto `kyl-express` que vale la pena traer

Son reglas del negocio que Luis definió y que conviene revisar si KiWi ya las cubre:
- **Precio por barrio de destino con tarifas propias por comercio.** El precio depende de dónde sale el viaje.
- **Saldo prepagado del comercio** (recarga por SINPE con comprobante y aprobación del admin, o con ONVO), y que se descuente por viaje con candado para que dos pedidos no gasten el mismo saldo.
- **Tres formas de pedir repartidor:** formulario, enlace para que el cliente marque su ubicación en un mapa, y botón rápido.
- **Cobro en efectivo opcional,** con confirmación del comercio.
- **Comisión de KyL configurable** (20 % por defecto) y registro de pagos a repartidores.

---

## 7. Orden sugerido

1. Leer este documento y el `ARCHITECTURE.md`/`DEPLOYMENT.md` del repo, y correr el proyecto en local.
2. Reactivar Supabase y Render a nombre de Luis. Crear Vercel.
3. Cambiar la marca (sección 3) y probar las 3 apps web.
4. Firebase y Google Maps a nombre de Luis.
5. Apps móviles nuevas (sección 4).
6. Prueba real con los comercios y repartidores de Luis.
7. Corte: DNS, webhook de ONVO, y avisar a los usuarios que instalen las apps nuevas.
