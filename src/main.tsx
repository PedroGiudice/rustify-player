/* ============================================================
   main.tsx — Dispatcher de plataforma.

   O boot do desktop mora inteiro em ./boot-desktop (cópia
   byte-a-byte do que este arquivo era). O boot mobile mora em
   ./mobile/MobileApp. Os dois entram por import DINÂMICO: assim
   o Vite gera dois chunks e o Android nunca baixa/avalia o CSS,
   os stores e os side effects de módulo do desktop (e vice-versa).

   Nada além deste dispatch deve existir aqui.
   ============================================================ */

const isAndroid = /Android/i.test(navigator.userAgent);

if (isAndroid) {
  import("./mobile/MobileApp").then((m) => m.mountMobile());
} else {
  import("./boot-desktop");
}
