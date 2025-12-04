BOT DE SEGUIMIENTO WHATSAPP + PANEL WEB (09h–22h) + QR ARREGLADO
=================================================================

Este proyecto ya viene listo para:

- Mostrar el QR en el CMD usando qrcode-terminal.
- Enviar mensajes SOLO entre las 09:00 y las 22:00 (hora del PC).
- Mantener el seguimiento aunque cierres el CMD (guarda todo en clientes.json).
- Editar los mensajes de seguimiento desde un panel web.

1. Requisitos
-------------
- Windows
- Node.js 18 o superior instalado

2. Instalación
--------------
1) Descomprime este ZIP en una carpeta, por ejemplo:
   C:\Users\TUUSUARIO\Documents\whatsapp-bot-seguimiento

2) Abre CMD y entra en la carpeta:
   cd C:\Users\TUUSUARIO\Documents\whatsapp-bot-seguimiento

3) Instala las dependencias (solo la primera vez):
   npm install

3. Ejecutar el bot
------------------
En la misma carpeta, ejecuta:

   npm start

En el CMD vas a ver:
- Mensaje: "Bot inicializado. Aguardando QR para conexão..."
- Cuando Baileys mande un nuevo QR, se va a limpiar la pantalla y aparecerá un código QR en ASCII.
  Ejemplo:
    📱 Escaneie este QR com o WhatsApp:
    (cuadradito de caracteres negros y blancos)

En tu celular:
- WhatsApp > Configurações/Ajustes > Dispositivos conectados > Conectar um dispositivo
- Escaneá el QR que aparece en el CMD.

Si el QR expira (código 408), Baileys vuelve a pedir otro y el CMD muestra un QR nuevo.

4. Panel de control
-------------------
- Con el bot corriendo y ya conectado, abre en tu navegador:
  http://localhost:3000/admin

Ahí puedes:
- Editar el mensaje de seguimiento de 3, 5, 7 y 15 días.
- Editar el mensaje recurrente (cada 15 días después).

Los textos se guardan en el archivo:
- mensajes.json

5. Cómo funciona el seguimiento
-------------------------------
- Cada mensaje que TÚ envías manualmente a un cliente desde ese número de WhatsApp (con el bot encendido):
  - Inicia o reinicia el funil para ese cliente.
  - El bot agenda mensajes automáticos si el cliente no responde:
      3 días  -> mensaje 1 (step0)
      5 días  -> mensaje 2 (step1)
      7 días  -> mensaje 3 (step2)
      15 días -> mensaje 4 (step3)
  - Después del día 15, cada 15 días manda el mensaje recurrente (extra).

- Importante:
  - El bot **solo envía mensajes entre las 09:00 y las 22:00** (según el horario del PC).
  - Si un mensaje está vencido durante la madrugada, se queda en la fila y solo sale cuando el reloj del PC esté entre 09h y 22h.

- Si el cliente responde:
  - El funil se reinicia desde cero (nuevo ciclo 3, 5, 7, 15, luego cada 15 días).

- Si el cliente manda algo como:
  "pare", "para", "não quero", "nao quero", "retire meu número", etc.
  -> el bot lo saca del funil y deja de enviarle mensajes.

- El bot:
  - No envía más de 1 mensaje por minuto en total.
  - Guarda el estado en:
      - clientes.json (seguimiento de cada número)
      - mensajes.json (textos configurados en el panel)

6. ¿Qué significa o código 408 que aparece a veces?
---------------------------------------------------
- 408 es un "timeout" de conexión: normalmente pasa cuando:
  - El QR expiró y no fue escaneado a tiempo.
- El propio bot vuelve a llamar a startBot() y se genera otro QR.
- Con esta versión, cada vez que haya un nuevo QR, se ve claramente en el CMD.

7. ¿Qué pasa si cierro el CMD o apago la PC?
-------------------------------------------
- El estado de los clientes (próximas fechas, etapa en el funil, etc.) se guarda en clientes.json.
- Cuando vuelvas a ejecutar `npm start`:
  - El bot lee clientes.json.
  - Ve qué clientes ya estaban con seguimiento.
  - Y si hay mensajes vencidos, los coloca en la fila para salir cuando esté dentro del horario permitido (09h–22h).

Es decir:
- El bot **no se olvida** de las tareas.
- Solo deja de funcionar mientras el proceso no esté corriendo.
- Al volver a encender, continúa donde se había quedado.

8. Archivos principales
-----------------------
- bot.js         -> código del bot y del panel web.
- package.json   -> configuraciones del proyecto Node.
- README.txt     -> este archivo.
