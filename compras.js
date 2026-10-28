// =============================================================
// MÓDULO COMPRAS: facturas y albaranes (con lectura automática por IA),
// pagos pendientes y proveedores.
// =============================================================
import {
  db, estado, ICONOS, $, esc, eur, leerEur, centimosATexto, mostrar, traducirError,
  fechaLarga, horaDe, iso
} from "./nucleo.js?v=2";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, writeBatch, query, where, orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Configuración para el lector de facturas (Firebase AI Logic, versión 12 del SDK)
const CONFIG_IA = {
  apiKey: "AIzaSyDnNDk2BwqW7h_gB3mbsHl4VZKSM5LN_iA",
  authDomain: "sweet-dreams-gestion.firebaseapp.com",
  projectId: "sweet-dreams-gestion",
  storageBucket: "sweet-dreams-gestion.firebasestorage.app",
  messagingSenderId: "870404185505",
  appId: "1:870404185505:web:83c91b8dde7a4d42a5bfe0"
};
const SDK_IA = "https://www.gstatic.com/firebasejs/12.9.0/";
const MODELO_IA = "gemini-3.8-flash";
const LIMITE_EFECTIVO = 100000; // 1.000 € en céntimos
const TIPOS_IVA = [21, 10, 5, 4, 2, 0];

export const moduloCompras = {
  id: "compras",
  titulo: "Compras",
  icono: ICONOS.compras,
  enBarra: true,
  roles: ["socio", "encargado", "equipo"],
  pestanas: [
    { id: "nueva", titulo: "Nueva factura" },
    { id: "facturas", titulo: "Facturas", roles: ["socio"] },
    { id: "pendientes", titulo: "Pendientes", roles: ["socio"] },
    { id: "proveedores", titulo: "Proveedores", roles: ["socio"] },
    { id: "factura", oculta: true, padre: "facturas", roles: ["socio"] },
    { id: "proveedor", oculta: true, padre: "proveedores", roles: ["socio"] }
  ],
  render: renderCompras,
  inicio: tarjetaInicio
};

// ---------- Estilos propios del módulo ----------
(function () {
  if (document.getElementById("css-compras")) return;
  const s = document.createElement("style");
  s.id = "css-compras";
  s.textContent = `
    .boton-archivo { display:block; width:100%; padding:14px; border-radius:10px; margin-top:10px; text-align:center;
      background:var(--rosa); color:#fff; font-weight:600; font-size:1rem; cursor:pointer; }
    .boton-archivo.sec { background:var(--panel2); border:1px solid var(--borde); }
    .foto-previa { max-width:100%; max-height:420px; border-radius:10px; margin-top:12px; display:block; }
    .linea { border:1px solid var(--borde); border-radius:10px; padding:10px; margin-bottom:10px; }
    .linea .tres { display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; }
    .linea .tres label { margin:6px 0 4px; font-size:.75rem; }
    .linea button { margin-top:8px; padding:8px; background:var(--rojoF); font-size:.85rem; }
    .badge { display:inline-block; font-size:.75rem; padding:2px 8px; border-radius:20px; margin-left:6px; font-weight:400; }
    .badge.pagada { background:var(--verdeF); }
    .badge.pendiente { background:var(--ambarF); }
    .badge.anulada, .badge.vencida { background:var(--rojoF); }
    .opciones-pago label { display:flex; gap:10px; align-items:center; color:var(--texto); margin:10px 0; font-size:1rem; }
    .opciones-pago input { width:auto; }
    .tabla-lineas > div { display:flex; justify-content:space-between; gap:10px; padding:7px 0; border-bottom:1px solid var(--borde); }
    .tabla-lineas small { display:block; color:var(--suave); }
  `;
  document.head.appendChild(s);
})();

// ---------- Utilidades del módulo ----------
const hoy = () => iso(new Date());
const esFecha = (t) => typeof t === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t);
const fechaCorta = (t) => esFecha(t) ? t.split("-").reverse().join("/") : "";
function num(v) {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v !== "string") return null;
  let s = v.replace(/[€\s%]/g, "");
  if (s === "") return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return isFinite(n) ? n : null;
}
function cent(v) { const n = num(v); return n === null ? null : Math.round(n * 100); }
function normCif(c) { return String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function textoNum(n) { return n === null || n === undefined ? "" : String(n).replace(".", ","); }
function msDe(ts) { return ts && ts.toMillis ? ts.toMillis() : 0; }

function calcularTotales(lineas) {
  const porIva = {};
  lineas.forEach((l) => {
    if (typeof l.importe !== "number") return;
    porIva[l.iva] = (porIva[l.iva] || 0) + l.importe;
  });
  const bases = Object.keys(porIva).map(Number).sort((a, b) => b - a)
    .map((t) => ({ tipoIva: t, base: porIva[t], cuota: Math.round(porIva[t] * t / 100) }));
  const totalBase = bases.reduce((s, b) => s + b.base, 0);
  const totalIva = bases.reduce((s, b) => s + b.cuota, 0);
  return { bases, totalBase, totalIva, total: totalBase + totalIva };
}

let proveedoresCache = null;
async function cargarProveedores(forzar = false) {
  if (proveedoresCache && !forzar) return proveedoresCache;
  const s = await getDocs(collection(db, "proveedores"));
  proveedoresCache = [];
  s.forEach((d) => proveedoresCache.push({ id: d.id, ...d.data() }));
  proveedoresCache.sort((a, b) => a.nombre.localeCompare(b.nombre));
  return proveedoresCache;
}
function buscarProveedor(nombre, cif) {
  const lista = proveedoresCache || [];
  const c = normCif(cif);
  if (c) {
    const p = lista.find((x) => normCif(x.cif) === c);
    if (p) return p;
  }
  const n = String(nombre || "").trim().toLowerCase();
  return n ? lista.find((x) => x.nombre.trim().toLowerCase() === n) : null;
}

function renderCompras({ sub, resto, cont }) {
  if (sub === "facturas") return pintarFacturas(cont);
  if (sub === "pendientes") return pintarPendientes(cont);
  if (sub === "proveedores") return pintarProveedores(cont);
  if (sub === "factura") return pintarDetalleFactura(cont, resto[0]);
  if (sub === "proveedor") return pintarFichaProveedor(cont, resto[0]);
  return pintarNueva(cont);
}

// =============================================================
// TARJETA DE INICIO
// =============================================================
async function tarjetaInicio(cont) {
  if (!estado.usuario.socio) {
    cont.innerHTML = `
      <div class="panel">
        <h2>¿Ha llegado un pedido?</h2>
        <p class="suave" style="margin:0">Hazle una foto a la factura o al albarán y la app la leerá sola.</p>
        <a class="boton" href="#/compras/nueva">Registrar factura</a>
      </div>`;
    return;
  }
  const mes = hoy().slice(0, 7) + "-01";
  const [sp, sm] = await Promise.all([
    getDocs(query(collection(db, "facturas"), where("estado", "==", "pendiente"))),
    getDocs(query(collection(db, "facturas"), where("fecha", ">=", mes)))
  ]);
  let nPend = 0, totPend = 0, nVenc = 0, totMes = 0;
  sp.forEach((d) => {
    const f = d.data();
    if (f.anulada) return;
    nPend++; totPend += f.total;
    if (f.vencimiento && f.vencimiento < hoy()) nVenc++;
  });
  sm.forEach((d) => { const f = d.data(); if (!f.anulada) totMes += f.total; });
  cont.innerHTML = `
    <div class="panel">
      <h2>Compras</h2>
      <div class="metricas">
        <div><small>Pendiente de pago</small><strong>${eur(totPend)}</strong></div>
        <div><small>Facturas pendientes</small><strong>${nPend}${nVenc ? ` <span class="badge vencida">${nVenc} vencida${nVenc > 1 ? "s" : ""}</span>` : ""}</strong></div>
        <div><small>Compras este mes</small><strong>${eur(totMes)}</strong></div>
      </div>
      <a class="boton" href="#/compras/nueva">Registrar factura</a>
      ${nPend ? `<a class="boton sec" href="#/compras/pendientes">Ver pendientes</a>` : ""}
    </div>`;
}

// =============================================================
// NUEVA FACTURA
// =============================================================
function borradorVacio() {
  return {
    adjunto: null,            // { tipo, datos (base64), nombre, guardable }
    tipo: "factura",
    proveedorNombre: "", cif: "", provTelefono: "", provEmail: "",
    numero: "", fecha: hoy(), vencimiento: "",
    lineas: [],
    totalFactura: null,       // total que pone el papel (céntimos)
    formaPago: "",            // cajaRoja | banco | pendiente
    observaciones: "",
    leidaConIA: false
  };
}
let borrador = borradorVacio();
let leyendo = false;

async function pintarNueva(cont) {
  try { await cargarProveedores(); } catch (e) { proveedoresCache = proveedoresCache || []; }
  const b = borrador;
  const adj = b.adjunto;
  cont.innerHTML = `<div id="nRaiz">
    <div class="panel">
      <h2>Foto o PDF de la factura</h2>
      <label class="boton-archivo" for="nCamara">Hacer foto</label>
      <input id="nCamara" type="file" accept="image/*" capture="environment" hidden>
      <label class="boton-archivo sec" for="nArchivo">Elegir foto o PDF del móvil</label>
      <input id="nArchivo" type="file" accept="image/*,application/pdf" hidden>
      ${adj ? (adj.tipo === "application/pdf"
        ? `<p style="margin-bottom:0">PDF: ${esc(adj.nombre)}${adj.guardable ? "" : ' <span class="badge anulada">demasiado grande para guardarlo</span>'}</p>`
        : `<img class="foto-previa" alt="Foto de la factura" src="data:image/jpeg;base64,${adj.datos}">`) : ""}
      ${leyendo ? `<div class="estado neutro">Leyendo la factura… puede tardar unos segundos.</div>` : ""}
      ${adj && !leyendo ? `<button class="sec" id="nReleer" type="button">Volver a leer con IA</button>` : ""}
      <small class="nota">También puedes rellenarla a mano sin foto.</small>
    </div>

    <div class="panel">
      <h2>Datos</h2>
      <label for="nTipo">Tipo de documento</label>
      <select id="nTipo" data-campo="tipo">
        <option value="factura" ${b.tipo === "factura" ? "selected" : ""}>Factura</option>
        <option value="albaran" ${b.tipo === "albaran" ? "selected" : ""}>Albarán</option>
      </select>
      <label for="nProv">Proveedor</label>
      <input id="nProv" data-campo="proveedorNombre" list="nListaProv" value="${esc(b.proveedorNombre)}" placeholder="Coca-Cola, Mahou…">
      <datalist id="nListaProv">${(proveedoresCache || []).map((p) => `<option value="${esc(p.nombre)}"></option>`).join("")}</datalist>
      <label for="nCif">CIF del proveedor</label>
      <input id="nCif" data-campo="cif" value="${esc(b.cif)}" autocapitalize="characters">
      <div class="fila">
        <div><label for="nNumero">Número</label><input id="nNumero" data-campo="numero" value="${esc(b.numero)}"></div>
        <div><label for="nFecha">Fecha</label><input id="nFecha" type="date" data-campo="fecha" value="${esc(b.fecha)}"></div>
      </div>
    </div>

    <div class="panel">
      <h2>Productos</h2>
      <div id="nLineas">${htmlLineas()}</div>
      <button class="sec" id="nAnadirLinea" type="button">Añadir producto</button>
      <div class="resumen" id="nTotales" style="margin-top:12px"></div>
      <label for="nTotalPapel">Total que pone la factura (€)</label>
      <input id="nTotalPapel" inputmode="decimal" data-campo="totalFactura" value="${b.totalFactura === null ? "" : centimosATexto(b.totalFactura)}">
      <div id="nAvisoTotal"></div>
    </div>

    <div class="panel">
      <h2>Pago</h2>
      <div class="opciones-pago">
        <label><input type="radio" name="nPago" value="cajaRoja" ${b.formaPago === "cajaRoja" ? "checked" : ""}> Pagada en efectivo con la caja roja</label>
        <label><input type="radio" name="nPago" value="banco" ${b.formaPago === "banco" ? "checked" : ""}> Ya pagada por banco o tarjeta</label>
        <label><input type="radio" name="nPago" value="pendiente" ${b.formaPago === "pendiente" ? "checked" : ""}> Pendiente de pago (la cobran por banco)</label>
      </div>
      <div id="nVencCaja" class="${b.formaPago === "pendiente" ? "" : "oculto"}">
        <label for="nVenc">Fecha prevista de pago (opcional)</label>
        <input id="nVenc" type="date" data-campo="vencimiento" value="${esc(b.vencimiento)}">
      </div>
      <div id="nAvisoEfectivo"></div>
      <label for="nObs">Observaciones (opcional)</label>
      <textarea id="nObs" data-campo="observaciones" placeholder="Faltaba una caja, viene un abono…">${esc(b.observaciones)}</textarea>
      <button id="nGuardar" type="button">Guardar factura</button>
      <button class="sec" id="nDescartar" type="button">Empezar de nuevo</button>
    </div>
  </div>`;

  // Archivos
  const alElegir = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) cargarArchivo(f, cont); };
  $("nCamara").addEventListener("change", alElegir);
  $("nArchivo").addEventListener("change", alElegir);
  if ($("nReleer")) $("nReleer").addEventListener("click", () => leerConIA(cont));

  // Campos simples
  $("nRaiz").addEventListener("input", alEscribir);
  $("nRaiz").addEventListener("change", alEscribir);

  // Productos
  $("nAnadirLinea").addEventListener("click", () => {
    borrador.lineas.push({ descripcion: "", cantidad: null, precio: null, iva: 21, importe: null });
    $("nLineas").innerHTML = htmlLineas();
    actualizarTotales();
  });
  $("nLineas").addEventListener("click", (e) => {
    if (!e.target.classList.contains("lQuitar")) return;
    const i = Number(e.target.closest(".linea").dataset.i);
    borrador.lineas.splice(i, 1);
    $("nLineas").innerHTML = htmlLineas();
    actualizarTotales();
  });

  $("nGuardar").addEventListener("click", () => guardarFactura(cont));
  $("nDescartar").addEventListener("click", () => {
    if (!confirm("¿Borrar lo que has rellenado y empezar de nuevo?")) return;
    borrador = borradorVacio();
    pintarNueva(cont);
  });
  actualizarTotales();
}

function alEscribir(e) {
  const t = e.target;
  if (t.name === "nPago") {
    borrador.formaPago = t.value;
    const p = $("nVencCaja");
    if (p) p.classList.toggle("oculto", t.value !== "pendiente");
    actualizarTotales();
    return;
  }
  const linea = t.closest && t.closest(".linea");
  if (linea) {
    const l = borrador.lineas[Number(linea.dataset.i)];
    if (!l) return;
    if (t.classList.contains("lDesc")) l.descripcion = t.value;
    if (t.classList.contains("lIva")) l.iva = Number(t.value);
    if (t.classList.contains("lImporte")) l.importe = cent(t.value);
    if (t.classList.contains("lCant") || t.classList.contains("lPrecio")) {
      if (t.classList.contains("lCant")) l.cantidad = num(t.value);
      else l.precio = num(t.value);
      if (l.cantidad !== null && l.precio !== null) {
        l.importe = Math.round(l.cantidad * l.precio * 100);
        linea.querySelector(".lImporte").value = centimosATexto(l.importe);
      }
    }
    actualizarTotales();
    return;
  }
  const campo = t.dataset && t.dataset.campo;
  if (!campo) return;
  if (campo === "totalFactura") borrador.totalFactura = cent(t.value);
  else borrador[campo] = t.value;
  if (campo === "proveedorNombre" && e.type === "change") {
    const p = buscarProveedor(t.value, "");
    if (p) {
      if (!borrador.cif && p.cif) { borrador.cif = p.cif; $("nCif").value = p.cif; }
      if (!borrador.formaPago && p.formaPagoHabitual) {
        borrador.formaPago = p.formaPagoHabitual === "efectivo" ? "cajaRoja" : "pendiente";
        const r = document.querySelector(`input[name="nPago"][value="${borrador.formaPago}"]`);
        if (r) r.checked = true;
        $("nVencCaja").classList.toggle("oculto", borrador.formaPago !== "pendiente");
      }
    }
  }
  actualizarTotales();
}

function htmlLineas() {
  if (!borrador.lineas.length) {
    return '<p class="suave" style="margin-top:0">Se rellenan solos al leer la factura. También puedes añadirlos a mano.</p>';
  }
  return borrador.lineas.map((l, i) => {
    const tipos = [...new Set([...TIPOS_IVA, l.iva])];
    return `
      <div class="linea" data-i="${i}">
        <input class="lDesc" value="${esc(l.descripcion)}" placeholder="Producto">
        <div class="tres">
          <div><label>Cantidad</label><input class="lCant" inputmode="decimal" value="${esc(textoNum(l.cantidad))}"></div>
          <div><label>Precio unidad</label><input class="lPrecio" inputmode="decimal" value="${esc(textoNum(l.precio))}"></div>
          <div><label>IVA %</label><select class="lIva">${tipos.map((t) => `<option value="${t}" ${t === l.iva ? "selected" : ""}>${t}</option>`).join("")}</select></div>
        </div>
        <label>Importe sin IVA (€)</label>
        <input class="lImporte" inputmode="decimal" value="${l.importe === null ? "" : centimosATexto(l.importe)}">
        <button type="button" class="lQuitar">Quitar producto</button>
      </div>`;
  }).join("");
}

function actualizarTotales() {
  const caja = $("nTotales");
  if (!caja) return;
  const t = calcularTotales(borrador.lineas);
  caja.innerHTML = t.bases.length
    ? t.bases.map((b) => `<div><span>Base al ${b.tipoIva} % / IVA</span><strong>${eur(b.base)} / ${eur(b.cuota)}</strong></div>`).join("") +
      `<div><span>Total calculado</span><strong>${eur(t.total)}</strong></div>`
    : "";
  const aviso = $("nAvisoTotal");
  if (borrador.totalFactura !== null && t.bases.length) {
    const dif = borrador.totalFactura - t.total;
    aviso.innerHTML = Math.abs(dif) <= 10
      ? `<div class="estado ok">Los productos cuadran con el total de la factura</div>`
      : `<div class="estado sobra" style="font-weight:400">El total calculado no coincide con el de la factura (diferencia ${eur(dif)}). Revisa los productos y el IVA.</div>`;
  } else {
    aviso.innerHTML = "";
  }
  const total = borrador.totalFactura ?? t.total;
  $("nAvisoEfectivo").innerHTML = borrador.formaPago === "cajaRoja" && total >= LIMITE_EFECTIVO
    ? `<div class="estado mal" style="font-weight:400">Atención: entre empresas no se puede pagar en efectivo una operación de 1.000 € o más. Mejor por banco.</div>`
    : "";
}

// ---------- Archivo y lectura con IA ----------
function leerComoBase64(file) {
  return new Promise((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1]);
    r.onerror = () => ko(new Error("No se ha podido leer el archivo"));
    r.readAsDataURL(file);
  });
}

async function comprimirImagen(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, ko) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => ko(new Error("No se ha podido abrir la imagen"));
      i.src = url;
    });
    let max = 1600, calidad = 0.72, datos = "";
    for (let intento = 0; intento < 6; intento++) {
      const factor = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * factor);
      c.height = Math.round(img.height * factor);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      datos = c.toDataURL("image/jpeg", calidad).split(",")[1];
      if (datos.length < 850000) break;
      max = Math.round(max * 0.8);
      calidad = Math.max(0.5, calidad - 0.06);
    }
    return datos;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function cargarArchivo(file, cont) {
  try {
    if (file.type === "application/pdf") {
      const datos = await leerComoBase64(file);
      borrador.adjunto = { tipo: "application/pdf", datos, nombre: file.name, guardable: datos.length < 900000 };
    } else {
      const datos = await comprimirImagen(file);
      borrador.adjunto = { tipo: "image/jpeg", datos, nombre: file.name, guardable: datos.length < 900000 };
    }
  } catch (e) {
    return mostrar(e.message, "mal");
  }
  await leerConIA(cont);
}

let modeloIA = null;
async function obtenerModelo() {
  if (modeloIA) return modeloIA;
  const { initializeApp } = await import(SDK_IA + "firebase-app.js");
  const { getAI, getGenerativeModel, GoogleAIBackend } = await import(SDK_IA + "firebase-ai.js");
  const appIA = initializeApp(CONFIG_IA, "lector-facturas");
  const ai = getAI(appIA, { backend: new GoogleAIBackend() });
  modeloIA = getGenerativeModel(ai, {
    model: MODELO_IA,
    generationConfig: { responseMimeType: "application/json", temperature: 0 }
  });
  return modeloIA;
}

const INSTRUCCIONES_IA = `Eres un asistente que lee facturas y albaranes de proveedores de un bar en España.
Devuelve SOLO un objeto JSON, sin ningún texto adicional, con esta forma:
{"tipo":"factura","proveedor":{"nombre":"","cif":"","telefono":"","email":""},"numero":"","fecha":"AAAA-MM-DD","vencimiento":"","lineas":[{"descripcion":"","cantidad":0,"precioUnitario":0,"iva":21,"importe":0}],"impuestos":[{"tipoIva":21,"base":0,"cuota":0}],"total":0,"formaPago":""}
Reglas:
- "tipo" es "factura" o "albaran".
- El proveedor es la empresa que emite el documento, no el cliente. El cliente es el bar Sweet Dreams.
- Los importes van en euros, como números con punto decimal y sin símbolo.
- "importe" de cada línea es el total de esa línea SIN IVA, con los descuentos ya aplicados. Si el documento muestra precios con IVA incluido, calcula el importe sin IVA.
- "precioUnitario" es el precio por unidad sin IVA.
- "iva" es el porcentaje de IVA de la línea (21, 10, 4 o 0). Envases, fianzas o depósitos sin IVA llevan 0.
- "total" es el total final a pagar que aparece en el documento.
- "fecha" y "vencimiento" en formato AAAA-MM-DD. Si no aparece el vencimiento, déjalo vacío.
- Si un dato no aparece o no se lee bien, déjalo vacío o en 0. No inventes nada.`;

async function leerConIA(cont) {
  const adj = borrador.adjunto;
  if (!adj || leyendo) return;
  leyendo = true;
  await pintarNueva(cont);
  try {
    const modelo = await obtenerModelo();
    const res = await modelo.generateContent([
      INSTRUCCIONES_IA,
      { inlineData: { data: adj.datos, mimeType: adj.tipo } }
    ]);
    const texto = res.response.text().replace(/```json|```/g, "").trim();
    aplicarLectura(JSON.parse(texto));
    borrador.leidaConIA = true;
    leyendo = false;
    await pintarNueva(cont);
    mostrar("Factura leída. Revisa los datos antes de guardar.", "ok");
  } catch (e) {
    leyendo = false;
    await pintarNueva(cont);
    mostrar("No se ha podido leer automáticamente (" + (e.message || e) + "). Puedes probar otra foto o rellenarla a mano.", "mal");
  }
}

function aplicarLectura(d) {
  const b = borrador;
  if (d.tipo) b.tipo = /albar/i.test(d.tipo) ? "albaran" : "factura";
  const p = d.proveedor || {};
  if (p.nombre) b.proveedorNombre = String(p.nombre).trim();
  if (p.cif) b.cif = normCif(p.cif);
  b.provTelefono = p.telefono ? String(p.telefono) : "";
  b.provEmail = p.email ? String(p.email) : "";
  if (d.numero) b.numero = String(d.numero).trim();
  if (esFecha(d.fecha)) b.fecha = d.fecha;
  if (esFecha(d.vencimiento)) b.vencimiento = d.vencimiento;
  if (Array.isArray(d.lineas)) {
    b.lineas = d.lineas.map((l) => {
      const cantidad = num(l.cantidad);
      const precio = num(l.precioUnitario);
      let importe = cent(l.importe);
      if (importe === null && cantidad !== null && precio !== null) importe = Math.round(cantidad * precio * 100);
      const iva = num(l.iva);
      return {
        descripcion: String(l.descripcion || "").trim(),
        cantidad, precio,
        iva: iva === null ? 21 : Math.round(iva),
        importe
      };
    }).filter((l) => l.descripcion || l.importe);
  }
  const total = cent(d.total);
  if (total !== null && total > 0) b.totalFactura = total;
  // Forma de pago habitual si ya conocemos al proveedor
  const conocido = buscarProveedor(b.proveedorNombre, b.cif);
  if (conocido) {
    b.proveedorNombre = conocido.nombre;
    if (!b.formaPago && conocido.formaPagoHabitual) b.formaPago = conocido.formaPagoHabitual === "efectivo" ? "cajaRoja" : "pendiente";
  }
}

// ---------- Guardar ----------
async function guardarFactura(cont) {
  const b = borrador;
  const u = estado.usuario;
  const t = calcularTotales(b.lineas);
  const total = b.totalFactura ?? t.total;

  if (!b.proveedorNombre.trim()) return mostrar("Falta el proveedor.", "mal");
  if (!b.numero.trim()) return mostrar("Falta el número de la factura o albarán.", "mal");
  if (!esFecha(b.fecha)) return mostrar("Falta la fecha.", "mal");
  if (b.lineas.some((l) => l.importe === null || isNaN(l.importe))) return mostrar("Hay productos sin importe. Rellénalo o quita ese producto.", "mal");
  if (!total || total <= 0) return mostrar("Falta el total de la factura.", "mal");
  if (!b.formaPago) return mostrar("Indica cómo se ha pagado o si está pendiente.", "mal");

  if (b.totalFactura !== null && t.bases.length && Math.abs(b.totalFactura - t.total) > 10 &&
      !confirm("Los productos no suman el total de la factura. ¿Guardar de todas formas?")) return;
  if (b.formaPago === "cajaRoja" && total >= LIMITE_EFECTIVO &&
      !confirm("Es un pago en efectivo de 1.000 € o más, y entre empresas no está permitido. ¿Seguro que quieres guardarlo así?")) return;

  // Aviso de factura repetida (solo socios pueden consultarlo)
  if (u.socio) {
    try {
      const s = await getDocs(query(collection(db, "facturas"), where("numero", "==", b.numero.trim())));
      let repetida = false;
      s.forEach((d) => {
        const f = d.data();
        if (!f.anulada && (normCif(f.cif) === normCif(b.cif) || f.proveedorNombre.toLowerCase() === b.proveedorNombre.trim().toLowerCase())) repetida = true;
      });
      if (repetida && !confirm("Ya hay una factura de este proveedor con ese número. ¿Guardarla otra vez?")) return;
    } catch (e) { /* si falla la comprobación, seguimos */ }
  }

  if (!confirm(`¿Guardar ${b.tipo === "albaran" ? "el albarán" : "la factura"} ${b.numero} de ${b.proveedorNombre} por ${eur(total)}?`)) return;

  const lote = writeBatch(db);
  let prov = buscarProveedor(b.proveedorNombre, b.cif);
  let provId;
  if (prov) {
    provId = prov.id;
  } else {
    const ref = doc(collection(db, "proveedores"));
    provId = ref.id;
    lote.set(ref, {
      nombre: b.proveedorNombre.trim(),
      cif: normCif(b.cif),
      telefono: b.provTelefono || "",
      email: b.provEmail || "",
      diasReparto: "",
      formaPagoHabitual: b.formaPago === "cajaRoja" ? "efectivo" : "banco",
      notas: "",
      activo: true,
      autorUid: u.uid,
      autorNombre: u.nombre,
      creadoEn: serverTimestamp()
    });
  }

  const refFactura = doc(collection(db, "facturas"));
  const conAdjunto = !!(b.adjunto && b.adjunto.guardable);
  if (conAdjunto) {
    lote.set(doc(db, "adjuntos", refFactura.id), {
      facturaId: refFactura.id,
      tipo: b.adjunto.tipo,
      datos: b.adjunto.datos,
      autorUid: u.uid,
      creadoEn: serverTimestamp()
    });
  }
  const pagada = b.formaPago !== "pendiente";
  lote.set(refFactura, {
    tipo: b.tipo,
    proveedorId: provId,
    proveedorNombre: b.proveedorNombre.trim(),
    cif: normCif(b.cif),
    numero: b.numero.trim(),
    fecha: b.fecha,
    lineas: b.lineas.map((l) => ({
      descripcion: l.descripcion.trim(), cantidad: l.cantidad, precio: l.precio, iva: l.iva, importe: l.importe
    })),
    bases: t.bases,
    totalBase: t.totalBase,
    totalIva: t.totalIva,
    totalCalculado: t.total,
    total,
    estado: pagada ? "pagada" : "pendiente",
    pagadaDesde: pagada ? b.formaPago : null,
    fechaPago: pagada ? hoy() : null,
    pagoEn: pagada ? serverTimestamp() : null,
    pagoPor: pagada ? u.nombre : null,
    vencimiento: pagada ? null : (b.vencimiento || null),
    observaciones: b.observaciones.trim(),
    leidaConIA: b.leidaConIA,
    adjunto: conAdjunto ? b.adjunto.tipo : null,
    anulada: false,
    autorUid: u.uid,
    autorNombre: u.nombre,
    creadoEn: serverTimestamp()
  });

  $("nGuardar").disabled = true;
  try {
    await lote.commit();
    proveedoresCache = null;
    const resumen = { ...b, total };
    borrador = borradorVacio();
    cont.innerHTML = `
      <div class="panel">
        <h2>${resumen.tipo === "albaran" ? "Albarán guardado" : "Factura guardada"}</h2>
        <div class="resumen">
          <div><span>Proveedor</span><strong>${esc(resumen.proveedorNombre)}</strong></div>
          <div><span>Número</span><strong>${esc(resumen.numero)}</strong></div>
          <div><span>Fecha</span><strong>${esc(fechaCorta(resumen.fecha))}</strong></div>
          <div><span>Total</span><strong>${eur(resumen.total)}</strong></div>
          <div><span>Pago</span><strong>${resumen.formaPago === "cajaRoja" ? "Efectivo, caja roja" : resumen.formaPago === "banco" ? "Pagada por banco" : "Pendiente"}</strong></div>
        </div>
        ${b.adjunto && !b.adjunto.guardable ? `<p class="suave">El PDF era demasiado grande para guardarlo en la app. Guarda el original en el correo del bar.</p>` : ""}
        <a class="boton" href="#/compras/nueva" id="nOtra">Registrar otra</a>
        <a class="boton sec" href="#/inicio">Volver al inicio</a>
      </div>`;
    window.scrollTo(0, 0);
  } catch (e) {
    mostrar("No se ha podido guardar: " + traducirError(e.code || e.message), "mal");
    $("nGuardar").disabled = false;
  }
}

// =============================================================
// LISTA DE FACTURAS (socios)
// =============================================================
function etiquetaEstado(f) {
  if (f.anulada) return '<span class="badge anulada">anulada</span>';
  if (f.estado === "pendiente") {
    return f.vencimiento && f.vencimiento < hoy()
      ? '<span class="badge vencida">vencida</span>'
      : '<span class="badge pendiente">pendiente</span>';
  }
  return '<span class="badge pagada">pagada</span>';
}
function itemFactura(f, extra = "") {
  return `
    <a class="item" href="#/compras/factura/${encodeURIComponent(f.id)}">
      <div class="top"><span>${esc(f.proveedorNombre)}${etiquetaEstado(f)}</span><span>${eur(f.total)}</span></div>
      <div class="sub"><span>${f.tipo === "albaran" ? "Albarán" : "Factura"} ${esc(f.numero)}</span><span>${esc(fechaCorta(f.fecha))}${extra}</span></div>
    </a>`;
}

async function pintarFacturas(cont) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const s = await getDocs(query(collection(db, "facturas"), orderBy("fecha", "desc"), limit(200)));
  const lista = [];
  s.forEach((d) => lista.push({ id: d.id, ...d.data() }));
  if (!lista.length) {
    cont.innerHTML = '<div class="panel">Todavía no hay facturas. Registra la primera desde «Nueva factura».</div>';
    return;
  }
  const meses = {};
  lista.forEach((f) => { (meses[f.fecha.slice(0, 7)] ||= []).push(f); });
  let html = "";
  Object.keys(meses).sort().reverse().forEach((m) => {
    const validas = meses[m].filter((f) => !f.anulada);
    const base = validas.reduce((a, f) => a + (f.totalBase || 0), 0);
    const iva = validas.reduce((a, f) => a + (f.totalIva || 0), 0);
    const total = validas.reduce((a, f) => a + f.total, 0);
    const nombreMes = new Date(m + "-01T12:00:00").toLocaleDateString("es-ES", { month: "long", year: "numeric" });
    html += `
      <div class="semana">
        <h3>${esc(nombreMes.charAt(0).toUpperCase() + nombreMes.slice(1))}</h3>
        <div class="panel resumen" style="padding:6px 14px">
          <div><span>Base imponible</span><strong>${eur(base)}</strong></div>
          <div><span>IVA soportado</span><strong>${eur(iva)}</strong></div>
          <div><span>Total compras</span><strong>${eur(total)}</strong></div>
        </div>
        ${meses[m].map((f) => itemFactura(f)).join("")}
      </div>`;
  });
  cont.innerHTML = html;
}

// =============================================================
// PENDIENTES DE PAGO (socios)
// =============================================================
async function pintarPendientes(cont) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const s = await getDocs(query(collection(db, "facturas"), where("estado", "==", "pendiente")));
  const lista = [];
  s.forEach((d) => { const f = { id: d.id, ...d.data() }; if (!f.anulada) lista.push(f); });
  if (!lista.length) {
    cont.innerHTML = '<div class="panel">No hay nada pendiente de pago.</div>';
    return;
  }
  lista.sort((a, b) => (a.vencimiento || "9999").localeCompare(b.vencimiento || "9999"));
  const total = lista.reduce((a, f) => a + f.total, 0);
  cont.innerHTML = `
    <div class="panel resumen" style="padding:6px 14px">
      <div><span>Total pendiente</span><strong>${eur(total)}</strong></div>
      <div><span>Facturas</span><strong>${lista.length}</strong></div>
    </div>
    <p class="suave">Pulsa una factura para marcarla como pagada cuando el banco la cobre.</p>
    ${lista.map((f) => itemFactura(f, f.vencimiento ? ", vence el " + esc(fechaCorta(f.vencimiento)) : "")).join("")}`;
}

// =============================================================
// DETALLE DE FACTURA (socios)
// =============================================================
async function pintarDetalleFactura(cont, id) {
  if (!id) { location.hash = "#/compras/facturas"; return; }
  const s = await getDoc(doc(db, "facturas", id));
  if (!s.exists()) { cont.innerHTML = '<div class="panel">No se ha encontrado esa factura.</div>'; return; }
  const f = { id, ...s.data() };
  const lineas = (f.lineas || []).map((l) => `
    <div><span>${esc(l.descripcion || "Producto")}<small>${l.cantidad !== null && l.cantidad !== undefined ? esc(textoNum(l.cantidad)) + " × " + esc(textoNum(l.precio)) + " € · " : ""}IVA ${l.iva} %</small></span><strong>${eur(l.importe || 0)}</strong></div>`).join("")
    || '<div><span class="suave">Sin detalle de productos</span></div>';
  const bases = (f.bases || []).map((b) => `<div><span>Base al ${b.tipoIva} % / IVA</span><strong>${eur(b.base)} / ${eur(b.cuota)}</strong></div>`).join("");
  const desde = { cajaRoja: "Efectivo, caja roja", banco: "Banco o tarjeta" };

  cont.innerHTML = `
    <a class="volver" href="#/compras/facturas">‹ Facturas</a>
    <div class="panel">
      <h2>${esc(f.proveedorNombre)}${etiquetaEstado(f)}</h2>
      <div class="resumen">
        <div><span>${f.tipo === "albaran" ? "Albarán" : "Factura"}</span><strong>${esc(f.numero)}</strong></div>
        <div><span>Fecha</span><strong>${esc(fechaCorta(f.fecha))}</strong></div>
        <div><span>CIF</span><strong>${esc(f.cif || "—")}</strong></div>
        <div><span>Registrada por</span><strong>${esc(f.autorNombre)}, ${esc(horaDe(f.creadoEn))}</strong></div>
      </div>
      ${f.leidaConIA ? '<small class="nota">Datos leídos automáticamente y revisados al guardar.</small>' : ""}
    </div>
    <div class="panel"><h2>Productos</h2><div class="tabla-lineas">${lineas}</div></div>
    <div class="panel"><h2>Importes</h2><div class="resumen">
      ${bases}
      <div><span>Total</span><strong>${eur(f.total)}</strong></div>
      ${f.totalCalculado && Math.abs(f.totalCalculado - f.total) > 10 ? `<div><span>Total según productos</span><strong>${eur(f.totalCalculado)}</strong></div>` : ""}
    </div></div>
    <div class="panel"><h2>Pago</h2><div class="resumen">
      ${f.estado === "pagada"
        ? `<div><span>Pagada</span><strong>${esc(desde[f.pagadaDesde] || f.pagadaDesde || "")}</strong></div>
           <div><span>Fecha de pago</span><strong>${esc(fechaCorta(f.fechaPago))} (${esc(f.pagoPor || "")})</strong></div>`
        : `<div><span>Estado</span><strong>Pendiente</strong></div>
           <div><span>Fecha prevista</span><strong>${esc(fechaCorta(f.vencimiento) || "Sin fecha")}</strong></div>`}
    </div>
    ${f.observaciones ? `<p style="margin-bottom:0"><strong>Observaciones:</strong> ${esc(f.observaciones)}</p>` : ""}
    </div>
    ${f.adjunto ? `<div class="panel"><h2>Documento original</h2><div id="dAdjunto"><button class="sec" id="dVerAdjunto" type="button">Ver ${f.adjunto === "application/pdf" ? "PDF" : "foto"}</button></div></div>` : ""}
    ${!f.anulada && f.estado === "pendiente" ? `
      <div class="panel">
        <h2>Marcar como pagada</h2>
        <label for="dDesde">¿Cómo se ha pagado?</label>
        <select id="dDesde"><option value="banco">Banco o tarjeta</option><option value="cajaRoja">Efectivo de la caja roja</option></select>
        <label for="dFechaPago">Fecha de pago</label>
        <input id="dFechaPago" type="date" value="${hoy()}">
        <button id="dPagar" type="button">Marcar como pagada</button>
      </div>` : ""}
    ${!f.anulada ? `
      <div class="panel">
        <h2>Anular</h2>
        <p class="suave" style="margin-top:0">Solo si está repetida o mal registrada. No se borra: queda marcada como anulada con el motivo. Si había un error, anúlala y vuelve a registrarla bien.</p>
        <label for="dMotivo">Motivo</label>
        <input id="dMotivo" placeholder="Registrada dos veces">
        <button class="peligro" id="dAnular" type="button">Anular factura</button>
      </div>` : `<div class="panel"><h2>Anulada</h2><p style="margin:0">${esc(f.motivoAnulacion || "")} (${esc(f.anuladaPor || "")})</p></div>`}`;

  if ($("dVerAdjunto")) {
    $("dVerAdjunto").addEventListener("click", async () => {
      $("dAdjunto").innerHTML = '<p class="suave">Cargando…</p>';
      try {
        const a = await getDoc(doc(db, "adjuntos", id));
        if (!a.exists()) { $("dAdjunto").innerHTML = '<p class="suave">No se encuentra el documento.</p>'; return; }
        const ad = a.data();
        if (ad.tipo === "application/pdf") {
          const bytes = Uint8Array.from(atob(ad.datos), (c) => c.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
          $("dAdjunto").innerHTML = `<a class="boton sec" href="${url}" target="_blank" rel="noopener" download="factura-${esc(f.numero)}.pdf">Abrir PDF</a>`;
        } else {
          $("dAdjunto").innerHTML = `<img class="foto-previa" alt="Foto de la factura" src="data:${ad.tipo};base64,${ad.datos}">`;
        }
      } catch (e) {
        $("dAdjunto").innerHTML = `<p class="suave">No se ha podido cargar: ${esc(traducirError(e.code || e.message))}</p>`;
      }
    });
  }

  if ($("dPagar")) {
    $("dPagar").addEventListener("click", async () => {
      const desdeSel = $("dDesde").value;
      const fecha = $("dFechaPago").value;
      if (!esFecha(fecha)) return mostrar("Indica la fecha de pago.", "mal");
      if (desdeSel === "cajaRoja" && f.total >= LIMITE_EFECTIVO &&
          !confirm("Es un pago en efectivo de 1.000 € o más, y entre empresas no está permitido. ¿Seguir?")) return;
      if (!confirm(`¿Marcar como pagada (${desde[desdeSel]}) el ${fechaCorta(fecha)}?`)) return;
      try {
        await updateDoc(doc(db, "facturas", id), {
          estado: "pagada", pagadaDesde: desdeSel, fechaPago: fecha,
          pagoEn: serverTimestamp(), pagoPor: estado.usuario.nombre
        });
        await pintarDetalleFactura(cont, id);
        mostrar("Factura marcada como pagada.", "ok");
      } catch (e) {
        mostrar("No se ha podido guardar: " + traducirError(e.code || e.message), "mal");
      }
    });
  }

  if ($("dAnular")) {
    $("dAnular").addEventListener("click", async () => {
      const motivo = $("dMotivo").value.trim();
      if (!motivo) return mostrar("Escribe el motivo de la anulación.", "mal");
      if (!confirm("¿Anular esta factura? Quedará registrada como anulada y no contará en los totales.")) return;
      try {
        await updateDoc(doc(db, "facturas", id), {
          anulada: true, motivoAnulacion: motivo, anuladaPor: estado.usuario.nombre, anuladaEn: serverTimestamp()
        });
        await pintarDetalleFactura(cont, id);
        mostrar("Factura anulada.", "ok");
      } catch (e) {
        mostrar("No se ha podido anular: " + traducirError(e.code || e.message), "mal");
      }
    });
  }
}

// =============================================================
// PROVEEDORES (socios)
// =============================================================
async function pintarProveedores(cont) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const anio = hoy().slice(0, 4);
  const [lista, sf] = await Promise.all([
    cargarProveedores(true),
    getDocs(query(collection(db, "facturas"), where("fecha", ">=", anio + "-01-01")))
  ]);
  const gasto = {};
  sf.forEach((d) => { const f = d.data(); if (!f.anulada) gasto[f.proveedorId] = (gasto[f.proveedorId] || 0) + f.total; });
  cont.innerHTML = `
    <a class="boton sec" href="#/compras/proveedor/nuevo" style="margin-top:0;margin-bottom:14px">Añadir proveedor</a>
    ${lista.length ? lista.map((p) => `
      <a class="item" href="#/compras/proveedor/${encodeURIComponent(p.id)}">
        <div class="top"><span>${esc(p.nombre)}${p.activo === false ? '<span class="badge anulada">inactivo</span>' : ""}</span><span>${eur(gasto[p.id] || 0)}</span></div>
        <div class="sub"><span>${esc(p.diasReparto || "Sin días de reparto")}</span><span>${p.formaPagoHabitual === "efectivo" ? "Efectivo" : "Banco"}, en ${anio}</span></div>
      </a>`).join("") : '<div class="panel">Todavía no hay proveedores. Se crean solos al registrar su primera factura.</div>'}`;
}

async function pintarFichaProveedor(cont, id) {
  const nuevo = !id || id === "nuevo";
  let p = { nombre: "", cif: "", telefono: "", email: "", diasReparto: "", formaPagoHabitual: "banco", notas: "", activo: true };
  if (!nuevo) {
    const s = await getDoc(doc(db, "proveedores", id));
    if (!s.exists()) { cont.innerHTML = '<div class="panel">No se ha encontrado ese proveedor.</div>'; return; }
    p = { ...p, ...s.data() };
  }
  cont.innerHTML = `
    <a class="volver" href="#/compras/proveedores">‹ Proveedores</a>
    <div class="panel">
      <h2>${nuevo ? "Nuevo proveedor" : esc(p.nombre)}</h2>
      <label for="pNombre">Nombre</label><input id="pNombre" value="${esc(p.nombre)}">
      <label for="pCif">CIF</label><input id="pCif" value="${esc(p.cif)}" autocapitalize="characters">
      <label for="pTel">Teléfono o WhatsApp</label><input id="pTel" inputmode="tel" value="${esc(p.telefono)}">
      <label for="pEmail">Correo</label><input id="pEmail" inputmode="email" autocapitalize="none" value="${esc(p.email)}">
      <label for="pDias">Días de pedido y reparto</label><input id="pDias" value="${esc(p.diasReparto)}" placeholder="Pedido martes, llega miércoles">
      <label for="pPago">Forma de pago habitual</label>
      <select id="pPago">
        <option value="banco" ${p.formaPagoHabitual !== "efectivo" ? "selected" : ""}>Banco (lo cobran después)</option>
        <option value="efectivo" ${p.formaPagoHabitual === "efectivo" ? "selected" : ""}>Efectivo al recibir</option>
      </select>
      <label for="pNotas">Notas</label><textarea id="pNotas" placeholder="Comercial, pedido mínimo…">${esc(p.notas)}</textarea>
      ${nuevo ? "" : `<label class="check"><input type="checkbox" id="pActivo" ${p.activo !== false ? "checked" : ""}> Proveedor activo</label>`}
      <button id="pGuardar" type="button">Guardar proveedor</button>
    </div>`;

  $("pGuardar").addEventListener("click", async () => {
    const datos = {
      nombre: $("pNombre").value.trim(),
      cif: normCif($("pCif").value),
      telefono: $("pTel").value.trim(),
      email: $("pEmail").value.trim(),
      diasReparto: $("pDias").value.trim(),
      formaPagoHabitual: $("pPago").value,
      notas: $("pNotas").value.trim()
    };
    if (!datos.nombre) return mostrar("Falta el nombre.", "mal");
    try {
      if (nuevo) {
        await setDoc(doc(collection(db, "proveedores")), {
          ...datos, activo: true, autorUid: estado.usuario.uid, autorNombre: estado.usuario.nombre, creadoEn: serverTimestamp()
        });
        proveedoresCache = null;
        location.hash = "#/compras/proveedores";
      } else {
        await updateDoc(doc(db, "proveedores", id), {
          ...datos, activo: $("pActivo").checked, actualizadoPor: estado.usuario.nombre, actualizadoEn: serverTimestamp()
        });
        proveedoresCache = null;
        mostrar("Proveedor guardado.", "ok");
      }
    } catch (e) {
      mostrar("No se ha podido guardar: " + traducirError(e.code || e.message), "mal");
    }
  });
}
