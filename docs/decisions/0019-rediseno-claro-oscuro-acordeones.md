# 0019 — Rediseño: blanco y negro, tema claro/oscuro, bloques plegables

- **Estado**: aceptada · 2026-11-27 · amplía [ADR 0003](0003-shadcn-ui-tailwind.md)

## Contexto
Con ETH ([ADR 0018](0018-eth-como-segundo-activo.md)) la página principal muestra el doble de gráficas y tablas. La columna de 1152 px con tarjetas fijas ya era larga. Hacía falta poder plegar lo que no se mira, ver los dos activos a la vez en pantallas grandes y que funcione en móvil. Ninguna información se añade ni se quita: solo cambia cómo se presenta.

## Decisión
- **Blanco y negro.** Los componentes son monocromos (fondo gris claro / negro, tarjetas blancas / grafito, primario negro / blanco). El color solo comunica datos, con tokens semánticos que cambian con el tema: `buy`, `sell`, `warn` (antes `yellow-*`), `chain` (violeta, Chainlink y motor), `info` (azul, maker), `gold` (ámbar). No se usan colores de paleta de Tailwind en los componentes de dominio.
- **Tema claro y oscuro.** `lib/theme.tsx`: un script en `<head>` pone la clase `dark` antes de pintar (tema guardado en `localStorage`, si no el del sistema). Selector sol/luna en la barra superior.
- **Gráficas canvas siempre oscuras.** El heatmap está pensado sobre negro (su paleta empieza en casi negro); `BookmapChart` y `CvdChart` van en una "pantalla" (`bg-screen`) en los dos temas, con grises neutros y el último precio en blanco.
- **Fuentes de Google** (`next/font`): Manrope para el texto y JetBrains Mono para cifras. Los canvas leen la mono de la variable `--font-mono` (`lib/chartFont.ts`).
- **Bloques plegables.** `components/Panel.tsx`: tarjeta acordeón; cada bloque (mapa, latencia, Polymarket, footprint, trades) y cada activo entero se pliega, y el estado se recuerda por bloque. Plegado, el contenido se desmonta (los canvas dejan de dibujar), pero los hooks viven en el panel del activo, así que los datos siguen llegando. Los estados en vivo quedan visibles en la cabecera aunque el bloque esté plegado.
- **Disposición.** Un activo debajo del otro; con pantallas de 1536 px o más, selector "lado a lado". El contenido de cada bloque usa container queries (`@container`), así se adapta al ancho de su tarjeta y no al de la ventana.
- Selectores en pastilla (`components/Segmented.tsx`) y barra superior común (`components/AppHeader.tsx`) en `/` y `/compare`.

## Consecuencias
- Nuevos componentes de dominio usan `Panel`, `Segmented` y los tokens; nada de `text-yellow-500` y similares.
- Las dos secciones de activo abren cada una sus canales WS (el doble que antes). Plegar un activo NO cierra sus canales: la cabecera sigue mostrando su precio y estado.
- `/replays` hereda el tema pero no se ha rediseñado.
