// =============================================================
// MÓDULO STOCK: recuentos, stock teórico, pedido sugerido, consumo y productos.
// Las entradas salen solas de las facturas registradas en Compras.
// =============================================================
import {
  db, estado, ICONOS, $, esc, eur, leerEur, centimosATexto, mostrar, traducirError, iso, ms
} from "./nucleo.js?v=2";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, query, where, orderBy, limit, serverTimestamp, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const CATEGORIAS = {
  alcohol: "Alcohol",
  cerveza: "Cervezas",
  refresco: "Refrescos y bebidas",
  sirope: "Siropes",
  desechable: "Vasos y desechables",
  otros: "Otros"
};
const ORDEN_CAT = Object.keys(CATEGORIAS);
const UNIDADES = ["botella", "botellín", "lata", "garrafa", "bolsa", "unidad", "caja", "kg"];
const FRACCIONES = [[0, "Nada abierto"], [0.25, "+ ¼ abierta"], [0.5, "+ ½ abierta"], [0.75, "+ ¾ abierta"]];
const DIAS_FACTURAS = 120;

export const moduloStock = {
  id: "stock",
  titulo: "Stock",
  icono: ICONOS.stock,
  enBarra: true,
  roles: ["socio", "encargado", "equipo"],
  pestanas: [
    { id: "recuento", titulo: "Recuento" },
    { id: "estado", titulo: "Stock", roles: ["socio"] },
    { id: "pedido", titulo: "Pedido", roles: ["socio"] },
    { id: "consumo", titulo: "Consumo", roles: ["socio"] },
    { id: "productos", titulo: "Productos", roles: ["socio"] },
    { id: "producto", oculta: true, padre: "productos", roles: ["socio"] }
  ],
  render: ({ sub, resto, cont }) => {
    if (sub === "estado") return pintarEstado(cont);
    if (sub === "pedido") return pintarPedido(cont);
    if (sub === "consumo") return pintarConsumo(cont);
    if (sub === "productos") return pintarProductos(cont);
    if (sub === "producto") return pintarFichaProducto(cont, resto[0]);
    return pintarRecuento(cont);
  },
  inicio: tarjetaInicio
};

// ---------- Estilos propios ----------
(function () {
  if (document.getElementById("css-stock")) return;
  const s = document.createElement("style");
  s.id = "css-stock";
  s.textContent = `
    .fr { display:grid; grid-template-columns:1fr 88px; gap:8px; align-items:center; padding:10px 0; border-bottom:1px solid var(--borde); }
    .fr:last-child { border-bottom:none; }
    .fr.abre { grid-template-columns:1fr 70px 112px; }
    .fr small { display:block; color:var(--suave); font-size:.8rem; margin-top:2px; }
    .fr select { padding:12px 6px; font-size:.9rem; }
    .badge { display:inline-block; font-size:.75rem; padding:2px 8px; border-radius:20px; margin-left:6px; font-weight:400; }
    .badge.bajo, .badge.revisar { background:var(--rojoF); }
    .badge.ok { background:var(--verdeF); }
    .badge.aviso { background:var(--ambarF); }
    .asignar { border:1px solid var(--borde); border-radius:12px; padding:12px; margin-bottom:10px; }
    .asignar .dos { display:grid; grid-template-columns:1fr 90px; gap:8px; }
    .asignar button { margin-top:8px; }
    .texto-pedido { white-space:pre-wrap; background:var(--panel2); border-radius:10px; padding:12px; font-size:.95rem; }
  `;
  document.head.appendChild(s);
})();

// ---------- Utilidades ----------
const hoy = () => iso(new Date());
const fechaCorta = (t) => (t ? t.split("-").reverse().join("/") : "");
function norm(t) {
  return String(t || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}
function num(v) {
  if (typeof v === "number" && isFinite(v)) return v;
  let s = String(v ?? "").trim().replace(/\s/g, "");
  if (s === "") return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return isFinite(n) ? n : null;
}
function fmt(x) {
  if (x === null || x === undefined) return "—";
  return (Math.round(x * 100) / 100).toLocaleString("es-ES", { maximumFractionDigits: 2 });
}
function unidadTexto(p, cantidad) {
  const u = p.unidad || "unidad";
  if (Math.abs(cantidad) === 1) return u;
  if (u === "botellín") return "botellines";
  if (u === "unidad") return "unidades";
  if (u === "kg") return "kg";
  return u + "s";
}
function adivinarCategoria(t) {
  const x = norm(t);
  if (/\b(RON|VODKA|GINEBRA|GIN|WHISK|LICOR|TEQUILA|JAGER|BRANDY|VERMUT|MARTINI|ORUJO|PACHARAN|CHUPITO|BAILEYS|AGUARDIENTE)/.test(x)) return "alcohol";
  if (/\b(CERVEZA|MAHOU|SAN MIGUEL|ESTRELLA|AMSTEL|HEINEKEN|ALHAMBRA|TERCIO|BOTELLIN|CORONA|DESPERADOS|ALAMBRA)/.test(x)) return "cerveza";
  if (/\b(JARABE|SIROPE|SYRUP|GRANADINA)/.test(x)) return "sirope";
  if (/\b(VASO|PAJITA|SERVILLETA|BOLSA|CUCHARILLA|POSAVASOS)/.test(x)) return "desechable";
  if (/\b(COCA|KAS|FANTA|SPRITE|SCHWEPPES|TONICA|REFRESCO|AGUA|ZUMO|BEBIDA|RED ?BULL|POWERKING|AQUARIUS|NESTEA|LIMON|NARANJA|SODA|GASEOSA)/.test(x)) return "refresco";
  return "otros";
}
function adivinarFactor(t) {
  const m = norm(t).match(/(\d+)\s*(UNDS?|UDS?|UNIDADES|U)\b/);
  return m ? Number(m[1]) : 1;
}
function nombreBonito(t) {
  const s = String(t || "").trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- Datos ----------
async function cargarProductos() {
  const s = await getDocs(collection(db, "productos"));
  const l = [];
  s.forEach((d) => l.push({ id: d.id, ...d.data() }));
  l.sort((a, b) => ORDEN_CAT.indexOf(a.categoria) - ORDEN_CAT.indexOf(b.categoria) || a.nombre.localeCompare(b.nombre));
  return l;
}

// Junta productos, recuentos y facturas para calcular el stock de cada producto (solo socios)
async function cargarTodo() {
  const desde = iso(new Date(Date.now() - DIAS_FACTURAS * 864e5));
  const [productos, sr, sf, sa] = await Promise.all([
    cargarProductos(),
    getDocs(query(collection(db, "recuentos"), orderBy("fecha", "desc"), limit(60))),
    getDocs(query(collection(db, "facturas"), where("fecha", ">=", desde))),
    getDoc(doc(db, "ajustes", "stock"))
  ]);
  const recuentos = [];
  sr.forEach((d) => recuentos.push({ id: d.id, ...d.data() }));
  recuentos.sort((a, b) => (a.fecha === b.fecha ? ms(a.creadoEn) - ms(b.creadoEn) : a.fecha.localeCompare(b.fecha)));
  const facturas = [];
  sf.forEach((d) => { const f = d.data(); if (!f.anulada) facturas.push({ id: d.id, ...f }); });
  const ignorados = new Set((sa.exists() && sa.data().ignorados) || []);

  // Qué texto de factura corresponde a qué producto
  const alias = new Map();
  productos.forEach((p) => (p.alias || []).forEach((a) => alias.set(a.t, { p, f: a.f || 1 })));

  const entradas = {};
  const sinAsignar = new Map();
  facturas.forEach((f) => (f.lineas || []).forEach((l) => {
    const t = norm(l.descripcion);
    if (!t) return;
    const a = alias.get(t);
    if (a) {
      const cant = Number(l.cantidad) || 0;
      const costeFactura = typeof l.precio === "number" ? l.precio * 100 : (cant ? (l.importe || 0) / cant : null);
      (entradas[a.p.id] ||= []).push({
        fecha: f.fecha, uds: cant * a.f,
        coste: costeFactura === null ? null : Math.round(costeFactura / a.f),
        proveedor: f.proveedorNombre
      });
    } else if (!ignorados.has(t)) {
      const x = sinAsignar.get(t) || { t, texto: l.descripcion, veces: 0, proveedor: f.proveedorNombre, ultima: f.fecha, precio: l.precio };
      x.veces++;
      if (f.fecha >= x.ultima) { x.ultima = f.fecha; x.precio = l.precio; x.proveedor = f.proveedorNombre; }
      sinAsignar.set(t, x);
    }
  }));

  // Para cada producto: último recuento, anterior, entradas, stock teórico, consumo y coste
  const info = {};
  productos.forEach((p) => {
    const cuentas = recuentos
      .filter((r) => r.lineas && typeof r.lineas[p.id] === "number")
      .map((r) => ({ fecha: r.fecha, cant: r.lineas[p.id], quien: r.autorNombre }));
    const ultimo = cuentas[cuentas.length - 1] || null;
    const anterior = cuentas[cuentas.length - 2] || null;
    const ent = (entradas[p.id] || []).slice().sort((a, b) => a.fecha.localeCompare(b.fecha));
    // Las compras del mismo día del recuento se consideran ya contadas
    const entre = (desdeF, hastaF) => ent.filter((e) => e.fecha > desdeF && (!hastaF || e.fecha <= hastaF)).reduce((s, e) => s + e.uds, 0);
    const conCoste = ent.filter((e) => e.coste !== null);
    info[p.id] = {
      ultimo, anterior,
      entradasDesde: ultimo ? entre(ultimo.fecha, null) : 0,
      teorico: ultimo ? ultimo.cant + entre(ultimo.fecha, null) : null,
      consumo: ultimo && anterior ? anterior.cant + entre(anterior.fecha, ultimo.fecha) - ultimo.cant : null,
      coste: conCoste.length ? conCoste[conCoste.length - 1].coste : (typeof p.coste === "number" ? p.coste : null),
      proveedor: p.proveedor || (ent.length ? ent[ent.length - 1].proveedor : "") || "Sin proveedor"
    };
  });
  return {
    productos, recuentos, info, ignorados,
    sinAsignar: [...sinAsignar.values()].sort((a, b) => b.veces - a.veces)
  };
}

function esBajo(p, i) {
  if (i.teorico === null) return false;
  if (typeof p.minimo === "number") return i.teorico <= p.minimo;
  return false;
}

function agrupar(productos) {
  const g = {};
  productos.forEach((p) => { (g[p.categoria || "otros"] ||= []).push(p); });
  return ORDEN_CAT.filter((c) => g[c]).map((c) => [c, g[c]]);
}

// =============================================================
// INICIO
// =============================================================
async function tarjetaInicio(cont) {
  if (!estado.usuario.socio) {
    cont.innerHTML = `
      <div class="panel">
        <h2>Recuento de stock</h2>
        <p class="suave" style="margin:0">Cuando te toque contar, hazlo desde aquí.</p>
        <a class="boton sec" href="#/stock/recuento">Hacer recuento</a>
      </div>`;
    return;
  }
  const d = await cargarTodo();
  if (!d.productos.length) {
    cont.innerHTML = `
      <div class="panel">
        <h2>Stock</h2>
        <p class="suave" style="margin:0">Todavía no hay productos. Empieza creándolos desde las facturas que ya has registrado.</p>
        <a class="boton sec" href="#/stock/productos">Configurar productos</a>
      </div>`;
    return;
  }
  const bajos = d.productos.filter((p) => p.activo !== false && esBajo(p, d.info[p.id])).length;
  const ultimo = d.recuentos[d.recuentos.length - 1];
  cont.innerHTML = `
    <div class="panel">
      <h2>Stock</h2>
      <div class="metricas">
        <div><small>Por debajo del mínimo</small><strong class="${bajos ? "neg" : "cero"}">${bajos}</strong></div>
        <div><small>Último recuento</small><strong>${ultimo ? esc(fechaCorta(ultimo.fecha)) : "Ninguno"}</strong></div>
      </div>
      ${d.sinAsignar.length ? `<p class="suave">Hay ${d.sinAsignar.length} productos de facturas sin asignar.</p>` : ""}
      <a class="boton sec" href="#/stock/${bajos ? "pedido" : "estado"}">${bajos ? "Ver pedido sugerido" : "Ver stock"}</a>
    </div>`;
}

// =============================================================
// RECUENTO (todos)
// =============================================================
let borradorRecuento = {}; // productoId -> { enteras: "texto", fraccion: número }
let notasRecuento = "";

async function pintarRecuento(cont) {
  const u = estado.usuario;
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const productos = (await cargarProductos()).filter((p) => p.activo !== false);
  if (!productos.length) {
    cont.innerHTML = `<div class="panel">${u.socio
      ? 'Todavía no hay productos. Créalos en la pestaña <a href="#/stock/productos">Productos</a>.'
      : "Todavía no hay productos para contar. Avisa a Brian."}</div>`;
    return;
  }
  // Último recuento de cada producto (solo socios pueden verlo)
  const antes = {};
  if (u.socio) {
    try {
      const sr = await getDocs(query(collection(db, "recuentos"), orderBy("fecha", "desc"), limit(30)));
      const lista = [];
      sr.forEach((d) => lista.push(d.data()));
      lista.sort((a, b) => (a.fecha === b.fecha ? ms(a.creadoEn) - ms(b.creadoEn) : a.fecha.localeCompare(b.fecha)));
      lista.forEach((r) => Object.entries(r.lineas || {}).forEach(([id, c]) => { antes[id] = { c, fecha: r.fecha }; }));
    } catch (e) { /* sin datos anteriores */ }
  }

  const fila = (p) => {
    const b = borradorRecuento[p.id] || { enteras: "", fraccion: 0 };
    const previo = antes[p.id] ? ` · antes ${fmt(antes[p.id].c)} (${fechaCorta(antes[p.id].fecha)})` : "";
    return `
      <div class="fr ${p.seAbre ? "abre" : ""}" data-id="${esc(p.id)}">
        <div>${esc(p.nombre)}<small>${esc(p.formato || "")}${p.formato ? " · " : ""}${p.seAbre ? esc(unidadTexto(p, 2)) + " cerradas" : "en " + esc(unidadTexto(p, 2))}${previo}</small></div>
        <input class="rEnteras" inputmode="decimal" placeholder="—" value="${esc(b.enteras)}" aria-label="${esc(p.nombre)}">
        ${p.seAbre ? `<select class="rFraccion" aria-label="Botella abierta de ${esc(p.nombre)}">${FRACCIONES.map(([v, t]) => `<option value="${v}" ${v === b.fraccion ? "selected" : ""}>${t}</option>`).join("")}</select>` : ""}
      </div>`;
  };

  cont.innerHTML = `
    <div class="panel">
      <h2>Recuento del ${esc(fechaCorta(hoy()))}</h2>
      <p class="suave" style="margin:0;line-height:1.5">Escribe cuántas hay de cada cosa. Lo que no cuentes, déjalo en blanco y se mantiene el recuento anterior. En las botellas, pon las cerradas y elige cuánto queda de la abierta.</p>
    </div>
    ${agrupar(productos).map(([cat, lista]) => `
      <div class="panel"><h2>${esc(CATEGORIAS[cat])}</h2>${lista.map(fila).join("")}</div>`).join("")}
    <div class="panel">
      <label for="rNotas">Notas (opcional)</label>
      <textarea id="rNotas" placeholder="Se rompió una botella de ron…">${esc(notasRecuento)}</textarea>
      <button id="rGuardar" type="button">Guardar recuento</button>
      <small class="nota">Un recuento guardado no se puede modificar. Si te equivocas, haz otro recuento de ese producto: siempre manda el último.</small>
    </div>`;

  cont.querySelectorAll(".fr").forEach((f) => {
    const id = f.dataset.id;
    const actualizar = () => {
      borradorRecuento[id] = {
        enteras: f.querySelector(".rEnteras").value,
        fraccion: f.querySelector(".rFraccion") ? Number(f.querySelector(".rFraccion").value) : 0
      };
    };
    f.addEventListener("input", actualizar);
    f.addEventListener("change", actualizar);
  });
  $("rNotas").addEventListener("input", (e) => { notasRecuento = e.target.value; });

  $("rGuardar").addEventListener("click", async () => {
    const lineas = {};
    let mal = null;
    productos.forEach((p) => {
      const b = borradorRecuento[p.id];
      if (!b || (String(b.enteras).trim() === "" && !b.fraccion)) return;
      const enteras = String(b.enteras).trim() === "" ? 0 : num(b.enteras);
      if (enteras === null || enteras < 0) { mal = p.nombre; return; }
      lineas[p.id] = Math.round((enteras + (b.fraccion || 0)) * 100) / 100;
    });
    if (mal) return mostrar("Revisa la cantidad de «" + mal + "».", "mal");
    const n = Object.keys(lineas).length;
    if (!n) return mostrar("No has contado ningún producto.", "mal");
    if (!confirm(`¿Guardar el recuento de ${n} producto${n > 1 ? "s" : ""}? No se podrá modificar.`)) return;
    $("rGuardar").disabled = true;
    try {
      await setDoc(doc(collection(db, "recuentos")), {
        fecha: hoy(),
        lineas,
        nProductos: n,
        notas: notasRecuento.trim(),
        autorUid: u.uid,
        autorNombre: u.nombre,
        creadoEn: serverTimestamp()
      });
      borradorRecuento = {};
      notasRecuento = "";
      cont.innerHTML = `
        <div class="panel">
          <h2>Recuento guardado</h2>
          <p class="suave" style="margin-top:0">${n} producto${n > 1 ? "s" : ""} contado${n > 1 ? "s" : ""} por ${esc(u.nombre)} el ${esc(fechaCorta(hoy()))}.</p>
          ${u.socio ? '<a class="boton" href="#/stock/pedido">Ver pedido sugerido</a>' : ""}
          <a class="boton sec" href="#/inicio">Volver al inicio</a>
        </div>`;
      window.scrollTo(0, 0);
    } catch (e) {
      mostrar("No se ha podido guardar: " + traducirError(e.code || e.message), "mal");
      $("rGuardar").disabled = false;
    }
  });
}

// =============================================================
// STOCK ACTUAL (socios)
// =============================================================
async function pintarEstado(cont) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const d = await cargarTodo();
  const activos = d.productos.filter((p) => p.activo !== false);
  if (!activos.length) {
    cont.innerHTML = '<div class="panel">Todavía no hay productos. Créalos en la pestaña <a href="#/stock/productos">Productos</a>.</div>';
    return;
  }
  cont.innerHTML = `
    <div class="panel">
      <p class="suave" style="margin:0;line-height:1.5">Stock teórico = último recuento + compras registradas desde entonces. Solo es exacto si todas las compras se registran en la app.</p>
      ${d.sinAsignar.length ? `<div class="estado sobra" style="font-weight:400">Hay ${d.sinAsignar.length} productos de facturas sin asignar. <a href="#/stock/productos">Asígnalos</a> para que sumen al stock.</div>` : ""}
    </div>
    ${agrupar(activos).map(([cat, lista]) => `
      <div class="panel"><h2>${esc(CATEGORIAS[cat])}</h2><div class="resumen">
        ${lista.map((p) => {
          const i = d.info[p.id];
          const bajo = esBajo(p, i);
          return `<div><span>${esc(p.nombre)}${bajo ? '<span class="badge bajo">bajo</span>' : ""}
              <small class="suave" style="display:block;font-size:.8rem">${i.ultimo ? `Contado ${fmt(i.ultimo.cant)} el ${esc(fechaCorta(i.ultimo.fecha))}${i.entradasDesde ? `, han entrado ${fmt(i.entradasDesde)}` : ""}` : "Sin recontar"}${typeof p.minimo === "number" ? ` · mínimo ${fmt(p.minimo)}` : ""}</small></span>
            <strong>${i.teorico === null ? "—" : fmt(i.teorico)}</strong></div>`;
        }).join("")}
      </div></div>`).join("")}`;
}

// =============================================================
// PEDIDO SUGERIDO (socios)
// =============================================================
async function pintarPedido(cont) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const d = await cargarTodo();
  const porProveedor = {};
  const sinDatos = [];
  d.productos.filter((p) => p.activo !== false).forEach((p) => {
    const i = d.info[p.id];
    const tieneObjetivo = typeof p.ideal === "number" || typeof p.minimo === "number";
    if (!tieneObjetivo) return;
    if (i.teorico === null) { sinDatos.push(p.nombre); return; }
    const objetivo = typeof p.ideal === "number" ? p.ideal : p.minimo;
    const hayQuePedir = typeof p.minimo === "number" ? i.teorico <= p.minimo : i.teorico < objetivo;
    if (!hayQuePedir || objetivo - i.teorico <= 0) return;
    const pack = p.pack && p.pack > 1 ? p.pack : 1;
    const cantidad = Math.ceil((objetivo - i.teorico) / pack) * pack;
    (porProveedor[i.proveedor] ||= []).push({ p, cantidad, pack, teorico: i.teorico });
  });

  const proveedores = Object.keys(porProveedor).sort();
  if (!proveedores.length) {
    cont.innerHTML = `
      <div class="panel">
        <h2>No hace falta pedir nada</h2>
        <p class="suave" style="margin:0;line-height:1.5">Ningún producto está por debajo de su mínimo. Para que esto funcione, cada producto necesita su mínimo y su stock de referencia (en Productos) y un recuento reciente.</p>
      </div>
      ${sinDatos.length ? `<div class="panel"><h2>Sin recontar</h2><p class="suave" style="margin:0">${sinDatos.map(esc).join(", ")}</p></div>` : ""}`;
    return;
  }

  const textoDe = (prov) => `Pedido Sweet Dreams (${fechaCorta(hoy())}):\n` + porProveedor[prov]
    .map((x) => `- ${fmt(x.cantidad)} ${unidadTexto(x.p, x.cantidad)} ${x.p.nombre}${x.pack > 1 ? ` (${fmt(x.cantidad / x.pack)} de ${x.pack})` : ""}`)
    .join("\n");

  cont.innerHTML = `
    <div class="panel">
      <p class="suave" style="margin:0;line-height:1.5">Se pide lo necesario para volver al stock de referencia de cada producto, redondeado a cajas completas si lo has indicado. Revísalo antes de enviarlo.</p>
    </div>
    ${proveedores.map((prov, k) => `
      <div class="panel">
        <h2>${esc(prov)}</h2>
        <div class="resumen">
          ${porProveedor[prov].map((x) => `<div><span>${esc(x.p.nombre)}<small class="suave" style="display:block;font-size:.8rem">Quedan ${fmt(x.teorico)}</small></span><strong>${fmt(x.cantidad)} ${esc(unidadTexto(x.p, x.cantidad))}</strong></div>`).join("")}
        </div>
        <div class="texto-pedido" id="tp${k}" style="margin-top:12px">${esc(textoDe(prov))}</div>
        <button class="sec bCompartir" data-k="${k}" type="button">Compartir o copiar</button>
      </div>`).join("")}
    ${sinDatos.length ? `<div class="panel"><h2>Sin recontar</h2><p class="suave" style="margin:0">${sinDatos.map(esc).join(", ")}</p></div>` : ""}`;

  cont.querySelectorAll(".bCompartir").forEach((b) => b.addEventListener("click", async () => {
    const texto = textoDe(proveedores[Number(b.dataset.k)]);
    try {
      if (navigator.share) { await navigator.share({ text: texto }); return; }
    } catch (e) { if (e.name === "AbortError") return; }
    try {
      await navigator.clipboard.writeText(texto);
      mostrar("Pedido copiado. Pégalo en WhatsApp.", "ok");
    } catch (e) {
      mostrar("No se ha podido copiar. Mantén pulsado el texto del pedido para copiarlo.", "mal");
    }
  }));
}

// =============================================================
// CONSUMO (socios)
// =============================================================
async function pintarConsumo(cont) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const d = await cargarTodo();
  const con = d.productos.filter((p) => d.info[p.id].consumo !== null);
  if (!con.length) {
    cont.innerHTML = '<div class="panel">El consumo aparece cuando un producto tiene al menos dos recuentos. Haz otro recuento dentro de unos días.</div>';
    return;
  }
  let total = 0;
  const html = agrupar(con).map(([cat, lista]) => {
    let subtotal = 0;
    const filas = lista.map((p) => {
      const i = d.info[p.id];
      const valor = i.coste !== null ? Math.round(i.consumo * i.coste) : null;
      if (valor !== null && i.consumo > 0) subtotal += valor;
      const negativo = i.consumo < 0;
      return `<div><span>${esc(p.nombre)}${negativo ? '<span class="badge revisar">revisar</span>' : ""}
          <small class="suave" style="display:block;font-size:.8rem">Del ${esc(fechaCorta(i.anterior.fecha))} al ${esc(fechaCorta(i.ultimo.fecha))}${valor !== null ? ` · ${eur(valor)}` : ""}${negativo ? " · hay más de lo que había: falta registrar una compra o el recuento está mal" : ""}</small></span>
        <strong>${fmt(i.consumo)} ${esc(unidadTexto(p, i.consumo))}</strong></div>`;
    }).join("");
    total += subtotal;
    return `<div class="panel"><h2>${esc(CATEGORIAS[cat])}${subtotal ? ` <span class="suave" style="font-weight:400">${eur(subtotal)}</span>` : ""}</h2><div class="resumen">${filas}</div></div>`;
  }).join("");
  cont.innerHTML = `
    <div class="panel resumen" style="padding:6px 14px">
      <div><span>Coste de lo consumido (sin IVA)</span><strong>${eur(total)}</strong></div>
    </div>
    <p class="suave" style="line-height:1.5">Consumo = recuento anterior + compras entre medias − último recuento. El coste sale del último precio de compra de cada producto.</p>
    ${html}`;
}

// =============================================================
// PRODUCTOS Y ASIGNACIÓN DE FACTURAS (socios)
// =============================================================
async function pintarProductos(cont) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const d = await cargarTodo();
  const opciones = d.productos.map((p) => `<option value="${esc(p.id)}">${esc(p.nombre)}</option>`).join("");

  cont.innerHTML = `
    ${d.sinAsignar.length ? `
      <div class="panel">
        <h2>Productos de facturas sin asignar (${d.sinAsignar.length})</h2>
        <p class="suave" style="margin-top:0;line-height:1.5">Dile a la app qué es cada línea de las facturas. Solo hay que hacerlo una vez: las próximas facturas lo reconocerán solas. «Unidades por cada una» sirve, por ejemplo, para una bolsa de 25 vasos (pon 25). Lo que no quieras controlar, ignóralo.</p>
        ${d.sinAsignar.slice(0, 40).map((x, k) => `
          <div class="asignar" data-k="${k}">
            <div><strong>${esc(x.texto)}</strong><small class="suave" style="display:block">${esc(x.proveedor || "")}${typeof x.precio === "number" ? ` · ${esc(fmt(x.precio))} € sin IVA` : ""} · ${x.veces} vez${x.veces > 1 ? "es" : ""}</small></div>
            <div class="dos" style="margin-top:8px">
              <select class="aProd"><option value="__nuevo">Crear producto nuevo</option>${opciones}</select>
              <input class="aFactor" inputmode="decimal" value="${adivinarFactor(x.texto)}" aria-label="Unidades por cada una">
            </div>
            <div class="fila">
              <button class="aAsignar" type="button">Asignar</button>
              <button class="sec aIgnorar" type="button">Ignorar</button>
            </div>
          </div>`).join("")}
      </div>` : ""}
    <a class="boton sec" href="#/stock/producto/nuevo" style="margin-top:0;margin-bottom:14px">Añadir producto a mano</a>
    ${d.productos.length ? agrupar(d.productos).map(([cat, lista]) => `
      <div class="semana"><h3>${esc(CATEGORIAS[cat])}</h3>
        ${lista.map((p) => `
          <a class="item" href="#/stock/producto/${encodeURIComponent(p.id)}">
            <div class="top"><span>${esc(p.nombre)}${p.activo === false ? '<span class="badge aviso">inactivo</span>' : ""}</span><span>${d.info[p.id].coste !== null ? eur(d.info[p.id].coste) : ""}</span></div>
            <div class="sub"><span>${esc(p.formato || p.unidad || "")}</span><span>${typeof p.minimo === "number" ? `mín. ${fmt(p.minimo)}` : "sin mínimo"}${typeof p.ideal === "number" ? ` · ref. ${fmt(p.ideal)}` : ""}</span></div>
          </a>`).join("")}
      </div>`).join("") : '<div class="panel">Todavía no hay productos.</div>'}`;

  cont.querySelectorAll(".asignar").forEach((caja) => {
    const x = d.sinAsignar[Number(caja.dataset.k)];
    caja.querySelector(".aAsignar").addEventListener("click", async () => {
      const prodId = caja.querySelector(".aProd").value;
      const factor = num(caja.querySelector(".aFactor").value);
      if (!factor || factor <= 0) return mostrar("Indica cuántas unidades trae cada una (normalmente 1).", "mal");
      try {
        if (prodId === "__nuevo") {
          const cat = adivinarCategoria(x.texto);
          await setDoc(doc(collection(db, "productos")), {
            nombre: nombreBonito(x.texto),
            categoria: cat,
            unidad: cat === "alcohol" || cat === "sirope" ? "botella" : cat === "desechable" ? "unidad" : "botella",
            formato: "",
            seAbre: cat === "alcohol" || cat === "sirope",
            minimo: null, ideal: null, pack: null,
            proveedor: x.proveedor || "",
            alias: [{ t: x.t, f: factor }],
            activo: true,
            autorUid: estado.usuario.uid, autorNombre: estado.usuario.nombre, creadoEn: serverTimestamp()
          });
          mostrar("Producto creado. Revisa su nombre, mínimo y stock de referencia en la lista.", "ok");
        } else {
          await updateDoc(doc(db, "productos", prodId), { alias: arrayUnion({ t: x.t, f: factor }) });
          mostrar("Asignado.", "ok");
        }
        await pintarProductos(cont);
      } catch (e) {
        mostrar("No se ha podido guardar: " + traducirError(e.code || e.message), "mal");
      }
    });
    caja.querySelector(".aIgnorar").addEventListener("click", async () => {
      try {
        await setDoc(doc(db, "ajustes", "stock"), { ignorados: arrayUnion(x.t) }, { merge: true });
        await pintarProductos(cont);
      } catch (e) {
        mostrar("No se ha podido guardar: " + traducirError(e.code || e.message), "mal");
      }
    });
  });
}

async function pintarFichaProducto(cont, id) {
  const nuevo = !id || id === "nuevo";
  let p = { nombre: "", categoria: "alcohol", unidad: "botella", formato: "", seAbre: true, minimo: null, ideal: null, pack: null, proveedor: "", coste: null, alias: [], activo: true };
  if (!nuevo) {
    const s = await getDoc(doc(db, "productos", id));
    if (!s.exists()) { cont.innerHTML = '<div class="panel">No se ha encontrado ese producto.</div>'; return; }
    p = { ...p, ...s.data() };
  }
  let proveedores = [];
  try {
    const sp = await getDocs(collection(db, "proveedores"));
    sp.forEach((d) => proveedores.push(d.data().nombre));
  } catch (e) { /* sin lista */ }

  const textoNum = (v) => (typeof v === "number" ? String(v).replace(".", ",") : "");
  cont.innerHTML = `
    <a class="volver" href="#/stock/productos">‹ Productos</a>
    <div class="panel">
      <h2>${nuevo ? "Nuevo producto" : esc(p.nombre)}</h2>
      <label for="sNombre">Nombre</label><input id="sNombre" value="${esc(p.nombre)}" placeholder="Ron Carioca">
      <label for="sCat">Tipo</label>
      <select id="sCat">${ORDEN_CAT.map((c) => `<option value="${c}" ${c === p.categoria ? "selected" : ""}>${esc(CATEGORIAS[c])}</option>`).join("")}</select>
      <div class="fila">
        <div><label for="sUnidad">Se cuenta por</label><select id="sUnidad">${UNIDADES.map((u) => `<option ${u === p.unidad ? "selected" : ""}>${u}</option>`).join("")}</select></div>
        <div><label for="sFormato">Formato</label><input id="sFormato" value="${esc(p.formato)}" placeholder="1 L, 2 L, 33 cl…"></div>
      </div>
      <label class="check"><input type="checkbox" id="sAbre" ${p.seAbre ? "checked" : ""}> Se abre y se gasta poco a poco (botellas de alcohol, siropes)</label>
      <div class="fila">
        <div><label for="sMinimo">Mínimo</label><input id="sMinimo" inputmode="decimal" value="${textoNum(p.minimo)}" placeholder="Avisar con…"></div>
        <div><label for="sIdeal">Stock de referencia</label><input id="sIdeal" inputmode="decimal" value="${textoNum(p.ideal)}" placeholder="Tener…"></div>
      </div>
      <small class="nota">Cuando queden igual o menos que el mínimo, se propone pedir hasta llegar al stock de referencia.</small>
      <div class="fila">
        <div><label for="sPack">Viene en cajas de</label><input id="sPack" inputmode="numeric" value="${textoNum(p.pack)}" placeholder="6, 24…"></div>
        <div><label for="sCoste">Coste (€ sin IVA)</label><input id="sCoste" inputmode="decimal" value="${typeof p.coste === "number" ? centimosATexto(p.coste) : ""}" placeholder="Si no hay facturas"></div>
      </div>
      <label for="sProv">Proveedor habitual</label>
      <input id="sProv" list="sListaProv" value="${esc(p.proveedor)}">
      <datalist id="sListaProv">${proveedores.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      ${nuevo ? "" : `<label class="check"><input type="checkbox" id="sActivo" ${p.activo !== false ? "checked" : ""}> Producto activo (si no, deja de salir en los recuentos)</label>`}
      <button id="sGuardar" type="button">Guardar producto</button>
    </div>
    ${!nuevo && (p.alias || []).length ? `
      <div class="panel">
        <h2>Cómo aparece en las facturas</h2>
        ${(p.alias || []).map((a, k) => `
          <div class="fila" style="align-items:center;border-bottom:1px solid var(--borde);padding:6px 0">
            <span>${esc(a.t)}<small class="suave" style="display:block">${a.f && a.f !== 1 ? `cada una son ${fmt(a.f)} ${esc(unidadTexto(p, a.f))}` : ""}</small></span>
            <button class="sec sQuitarAlias" data-k="${k}" type="button" style="margin:0">Quitar</button>
          </div>`).join("")}
      </div>` : ""}`;

  $("sGuardar").addEventListener("click", async () => {
    const opcional = (idCampo) => { const v = $(idCampo).value.trim(); return v === "" ? null : num(v); };
    const datos = {
      nombre: $("sNombre").value.trim(),
      categoria: $("sCat").value,
      unidad: $("sUnidad").value,
      formato: $("sFormato").value.trim(),
      seAbre: $("sAbre").checked,
      minimo: opcional("sMinimo"),
      ideal: opcional("sIdeal"),
      pack: opcional("sPack"),
      coste: $("sCoste").value.trim() === "" ? null : leerEur($("sCoste").value),
      proveedor: $("sProv").value.trim()
    };
    if (!datos.nombre) return mostrar("Falta el nombre.", "mal");
    if ([datos.minimo, datos.ideal, datos.pack].some((v) => v !== null && (isNaN(v) || v < 0)) || (datos.coste !== null && isNaN(datos.coste))) {
      return mostrar("Revisa los números: solo cifras, con coma para los decimales.", "mal");
    }
    try {
      if (nuevo) {
        await setDoc(doc(collection(db, "productos")), {
          ...datos, alias: [], activo: true,
          autorUid: estado.usuario.uid, autorNombre: estado.usuario.nombre, creadoEn: serverTimestamp()
        });
        location.hash = "#/stock/productos";
      } else {
        await updateDoc(doc(db, "productos", id), {
          ...datos, activo: $("sActivo").checked,
          actualizadoPor: estado.usuario.nombre, actualizadoEn: serverTimestamp()
        });
        mostrar("Producto guardado.", "ok");
      }
    } catch (e) {
      mostrar("No se ha podido guardar: " + traducirError(e.code || e.message), "mal");
    }
  });

  cont.querySelectorAll(".sQuitarAlias").forEach((b) => b.addEventListener("click", async () => {
    const k = Number(b.dataset.k);
    if (!confirm("¿Quitar esta línea de factura? Volverá a aparecer como «sin asignar».")) return;
    try {
      const alias = (p.alias || []).filter((_, i) => i !== k);
      await updateDoc(doc(db, "productos", id), { alias });
      await pintarFichaProducto(cont, id);
    } catch (e) {
      mostrar("No se ha podido quitar: " + traducirError(e.code || e.message), "mal");
    }
  }));
}
