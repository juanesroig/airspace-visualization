# Picking por GPU en el layer WebGL

Estado: tareas 1–7 implementadas y **sin commitear**; no probado aún en el navegador.
Tarea 8 explicada, sin empezar.
Escrito 2026-10-13.
Rama: `webgl-shader`. Ficheros: `src/webgl.ts`, `src/App.tsx`, `src/utils.ts`, `CLAUDE.md`.

---

## Dónde lo dejamos

Working tree al cerrar la sesión:

```
 M CLAUDE.md            ← sección Architecture reescrita para WebGLCustomLayer
 M package.json         ← fuera three y @types/three
 M package-lock.json
D  public/airplane.svg  ← solo lo usaba map.ts
 M src/App.tsx          ← click/hover con pick(), fuera aircrafts_layer_ref
D  src/map.ts           ← AircraftLayer (Three.js) eliminado
 M src/utils.ts         ← fuera lerp/unlerp/remap/project_position
 M src/webgl.ts         ← todo el picking
```

`tsc -b`, `eslint` y `vite build` pasan limpios.

**Lo primero en la próxima sesión:** `npm run dev` con el backend en `:5000` y comprobar:

- hover sobre un avión → cursor `pointer` y su card resaltada;
- click → seleccionado en azul + `flyTo` + su card sube la primera;
- click en vacío → deselecciona;
- dos aviones solapados → gana el de delante.

Si funciona, commitear antes de empezar la tarea 8.

---

## Resumen de lo implementado (tareas 1–7)

**Idea:** volver a dibujar los aviones en un framebuffer fuera de pantalla, pintando cada
instancia con un color que codifica su id, y leer con `readPixels` el píxel bajo el cursor.

1. **Shaders.** El vertex shader saca `flat out vec4 v_pick_color` con `gl_InstanceID + 1`
   repartido en R/G/B (8 bits por canal, 0 = nada). `PICKING_FRAGMENT_SHADER_SRC` lo escribe
   tal cual. `flat` evita que la interpolación altere el id; `/255.0` es exacto en RGBA8.
2. **Dos programas.** Helpers `create_shader` / `create_program` (devuelve `ProgramInfo` con
   los uniforms). Localizaciones de attributes fijadas con `layout(location = N)`
   (`A_*_LOC`) para que color y picking las compartan: el pase de picking reutiliza los
   attributes ya enlazados y solo cambia el programa.
3. **Framebuffer.** `ensure_picking_framebuffer`: renderbuffers RGBA8 + `DEPTH_COMPONENT24`
   del tamaño del drawing buffer, recreados perezosamente al cambiar de tamaño.
   `onRemove` libera programas, buffers y FBO.
4. **`hex_by_instance`.** Índice de instancia → hex, reconstruido en `update_aircrafts`.
   De paso: `instance_index_by_hex` / `color_index_by_hex` se vacían en cada update (antes
   un avión desaparecido seguía apuntando a un slot reutilizado por otro).
5. **Pase de picking** (`run_picking_pass`, dentro de `render`): bind FBO, viewport,
   `clearColor(0,0,0,0)`, clear, `disable(BLEND)`, draw, `readPixels` por petición.
   **No guarda ni restaura estado**: MapLibre pone depth 3D (test + escritura) antes de
   llamar a `render` y hace `setDirty()` después (verificado en `maplibre-gl-dev.js` 5.24).
6. **`pick(point)`** → `Promise<hex | null>`. Convierte px CSS a px del drawing buffer con
   `canvas.width / clientWidth` (no `devicePixelRatio`) e invierte Y. Encola la petición
   (`pending_picks`) y se resuelve en el siguiente frame. **Cola, no "la última gana"**: el
   draw es uno solo por frame y los `readPixels` extra solo copian 4 bytes; descartar
   peticiones producía `null` falsos que cruzaban click y hover.
7. **`App.tsx`.** `click`/`mousemove` llaman a `pick()`; cada handler numera sus peticiones
   (`latest_click`, `latest_hover`) e ignora respuestas que no sean la última, más un flag
   `disposed` en el cleanup. `update_selected_aircraft` ahora también hace
   `set_selected_aircraft` (antes las cards no se enteraban).

**Reglas que no se ven en el código** (también en `CLAUDE.md`):

- El picking solo es seguro **dentro de `render`**: fuera, la caché de estado de MapLibre y
  sus VAOs se corromperían.
- Cambiar `renderingMode` a `'2d'` pondría la profundidad en solo lectura y rompería el
  picking en silencio.

---

## Tarea 8: pulido (pendiente)

Tres partes independientes. Orden propuesto: **8a → 8b → 8c (opcional)**.

### 8a. Aviones de la cara oculta del globo — bug

**Problema.** El depth buffer del FBO de picking empieza vacío y no contiene el globo. Con
el mapa alejado, un avión de la otra cara de la Tierra se proyecta dentro del disco del
globo y nada lo tapa en el FBO → un click sobre el globo puede devolver un avión invisible.
En el pase de color no sabemos si pasa (depende de si el globo de MapLibre escribe
profundidad); en el picking pasa seguro.

**Comprobación previa en el navegador:** alejar hasta ver el globo entero y mirar si se ven
aviones "a través" de la Tierra. Si se ven, el arreglo también arregla el render; si no,
solo el picking. El cambio es el mismo en ambos casos.

**Opción recomendada — culling en el vertex shader:**

- En JS, posición de la cámara a partir de la inversa de la matriz:
  `c = inverse(mainMatrix) * (0, 0, 1, 0)`, y luego `c.xyz / c.w`.
  Se pasa como `uniform vec3 u_camera_pos` (a los dos programas).
- En el shader, el avión es visible si la cámara está en su semiespacio exterior:
  `dot(normalize(p_aircraft), u_camera_pos) > 1.0` (esfera unidad).
- Si no es visible, `gl_Position` fuera del volumen de recorte → la GPU lo descarta.
- Vertex shader compartido → arregla los dos pases a la vez y ahorra rasterizado.

**Descartada — copiar el depth de MapLibre con `blitFramebuffer`:** los formatos deben
coincidir exactamente (el de MapLibre probablemente `DEPTH24_STENCIL8`, posiblemente
multisample con antialias) y no sabemos si el globo escribe profundidad. Frágil.

### 8b. Scissor — rendimiento

Hoy cada pase limpia y rasteriza el FBO entero (≈ 8 M de píxeles en 4K) para leer 1–2.

- `gl.enable(gl.SCISSOR_TEST)` + `gl.scissor(...)` sobre el **rectángulo que engloba todas
  las peticiones de la cola** (1×1 con una sola petición). `clear` y rasterizado quedan
  limitados a esa zona.
- Desactivarlo al final del pase (MapLibre no lo rastrea en `setDirty()`; solo lo usa en un
  sitio y lo apaga justo después).

**Límite:** no ahorra trabajo de vértices: el vertex shader corre para todos los aviones
(≈ 1953 vértices cada uno), así que un frame con picking duplica el coste de vértices.
La 8a lo reduce en parte.

**Fuera de alcance por ahora:** la espera de `readPixels` a la GPU. Si se nota, existe la
lectura asíncrona de WebGL2 (`readPixels` a un `PIXEL_PACK_BUFFER` + `fenceSync` +
lectura 1–2 frames después): quita la espera a cambio de latencia. Medir antes.

### 8c. Modo debug — opcional

Campo `debug_picking = false`; si está activo, tras el pase de picking `blitFramebuffer`
del FBO a una esquina de la pantalla.

Pegas:

- Colores casi negros: con ids < 65 536, B = 0 y G muy bajo; solo varía el rojo. Verlo bien
  requiere un shader que mapee id → tono.
- **Choca con el scissor**: con 8b el FBO solo tiene un píxel dibujado; el modo debug
  tendría que desactivarlo.
- Solo se actualiza cuando hay peticiones (al mover el ratón).
- Hay que decidir cómo se activa (consola, tecla…).

Propuesta: saltarla salvo que el picking falle y haga falta ver el FBO.

---

## Otras tareas pendientes

- **Color de hover en el globo.** `WebGLCustomLayer` solo pinta el seleccionado; al hacer
  hover cambian cursor y card, pero el avión no. Añadir `HOVERED_COLOR_RGBA` +
  `hover_aircraft(hex)` al layer. Tarea aparte, no es parte del picking.
- **`public/airplane.glb`.** Ya no se carga en runtime; se dejó porque `src/aircraft.ts` está
  generado a partir de él. Borrar solo si el generador y el `.glb` viven en otro sitio.
