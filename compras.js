// =============================================================
// MÓDULO COMPRAS (versión 3): facturas y albaranes con lectura automática por IA,
// descuentos, unidades por caja, regalos, cargos extra (punto verde, GTR…),
// albaranes que esperan su factura, pagos pendientes y proveedores.
// =============================================================
import {
  db, estado, ICONOS, $, esc, eur, leerEur, centimosATexto, mostrar, traducirError,
  horaDe, iso
} from "./nucleo.js?v=4";
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
// Modelos de IA por orden de preferencia (cada uno tiene su propio cupo diario gratuito)
const MODELOS_IA = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash", "gemini-3.6-flash"];
// Lector de PDF (pdf.js): convierte las páginas del PDF en imágenes antes de enviarlas a la IA
const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/";
const MAX_PAGINAS_PDF = 3;
const LIMITE_EFECTIVO = 100000; // 1.000 € en céntimos
const TIPOS_IVA = [21, 10, 5, 4, 2, 0];
const CARGOS_HABITUALES = ["Punto verde", "GTR (gestión de residuos)", "GST (gestión de envases)", "Portes", "Otros"];

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
    .linea.regalo { border-style:dashed; }
    .linea .tres { display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; }
    .linea .tres label, .cargo label { margin:6px 0 4px; font-size:.75rem; }
    .linea .pie { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:8px; }
    .linea .pie .check { margin:0; }
    .linea .pie small { color:var(--suave); }
    .linea button, .cargo button { margin:0; padding:8px 10px; width:auto; background:var(--rojoF); font-size:.85rem; }
    .cargo { display:grid; grid-template-columns:1fr 90px 70px; gap:6px; align-items:end; margin-bottom:8px; }
    .cargo button { grid-column:1 / -1; justify-self:start; }
    .badge { display:inline-block; font-size:.75rem; padding:2px 8px; border-radius:20px; margin-left:6px; font-weight:400; }
    .badge.pagada { background:var(--verdeF); }
    .badge.pendiente, .badge.espera { background:var(--ambarF); }
    .badge.anulada, .badge.vencida { background:var(--rojoF); }
    .badge.regalo { background:var(--verdeF); }
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
function sumarDias(fecha, dias) {
  const [y, m, d] = fecha.split("-").map(Number);
  return iso(new Date(y, m - 1, d + dias));
}

// Qué cuenta para cada cosa
const esAlbaran = (f) => f.tipo === "albaran";
const cuentaComoGasto = (f) => !f.anulada && !(esAlbaran(f) && f.facturaId); // el albarán ya facturado lo cuenta su factura
const esFiscal = (f) => !f.anulada && !esAlbaran(f); // IVA soportado: solo facturas
const albaranSinFactura = (f) => !f.anulada && esAlbaran(f) && !f.facturaId;

// Descuento: "15%" = porcentaje sobre el bruto; "132" = euros
function calcularDescuento(texto, bruto) {
  const t = String(texto || "").trim();
  if (!t) return 0;
  if (t.includes("%")) {
    const p = num(t);
    return p === null ? 0 : Math.round(bruto * p / 100);
  }
  return cent(t) || 0;
}

function calcularTotales(lineas, cargos) {
  const porIva = {};
  const sumar = (iva, importe) => {
    if (typeof importe !== "number" || isNaN(importe)) return;
    porIva[iva] = (porIva[iva] || 0) + importe;
  };
  lineas.forEach((l) => sumar(l.iva, l.regalo ? 0 : l.importe));
  (cargos || []).forEach((c) => sumar(c.iva, c.importe));
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

// Albaranes que esperan su factura (los pueden ver también los del equipo, para vincularlos)
async function cargarAlbaranesPendientes() {
  const s = await getDocs(query(collection(db, "facturas"), where("tipo", "==", "albaran"), where("facturaId", "==", null)));
  const l = [];
  s.forEach((d) => { const f = { id: d.id, ...d.data() }; if (!f.anulada) l.push(f); });
  l.sort((a, b) => a.fecha.localeCompare(b.fecha));
  return l;
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
  const [sp, sm, alb] = await Promise.all([
    getDocs(query(collection(db, "facturas"), where("estado", "==", "pendiente"))),
    getDocs(query(collection(db, "facturas"), where("fecha", ">=", mes))),
    cargarAlbaranesPendientes()
  ]);
  let nPend = 0, totPend = 0, nVenc = 0, totMes = 0;
  sp.forEach((d) => {
    const f = d.data();
    if (f.anulada || esAlbaran(f)) return;
    nPend++; totPend += f.total;
    if (f.vencimiento && f.vencimiento < hoy()) nVenc++;
  });
  sm.forEach((d) => { const f = d.data(); if (cuentaComoGasto(f)) totMes += f.total; });
  cont.innerHTML = `
    <div class="panel">
      <h2>Compras</h2>
      <div class="metricas">
        <div><small>Pendiente de pago</small><strong>${eur(totPend)}</strong></div>
        <div><small>Facturas pendientes</small><strong>${nPend}${nVenc ? ` <span class="badge vencida">${nVenc} vencida${nVenc > 1 ? "s" : ""}</span>` : ""}</strong></div>
        <div><small>Compras este mes</small><strong>${eur(totMes)}</strong></div>
        <div><small>Albaranes sin factura</small><strong>${alb.length}</strong></div>
      </div>
      <a class="boton" href="#/compras/nueva">Registrar factura</a>
      ${nPend || alb.length ? `<a class="boton sec" href="#/compras/pendientes">Ver pendientes</a>` : ""}
    </div>`;
}

// =============================================================
// NUEVA FACTURA O ALBARÁN
// =============================================================
function lineaVacia() {
  return { descripcion: "", cantidad: null, bulto: 1, precio: null, descuentoTexto: "", descuento: 0, importe: null, iva: 21, regalo: false };
}
function borradorVacio() {
  return {
    adjunto: null,            // { tipo, datos (base64), nombre, guardable, paginas }
    tipo: "factura",          // factura | albaran
    proveedorNombre: "", cif: "", provTelefono: "", provEmail: "",
    numero: "", fecha: hoy(), vencimiento: "",
    lineas: [],
    cargos: [],               // { concepto, importe (céntimos), iva }
    basesPapel: null,         // bases e IVA tal como vienen impresos (para comprobar)
    totalFactura: null,       // total que pone el papel (céntimos)
    formaPago: "",            // cajaRoja | banco | pendiente | conFactura
    albaranId: "",            // si es la factura de un albarán ya registrado
    observaciones: "",
    leidaConIA: false
  };
}
let borrador = borradorVacio();
let leyendo = false;
let albaranesPendientes = [];

// Recalcula el bruto, el descuento y el neto de una línea
function recalcularLinea(l) {
  if (l.regalo) { l.importe = 0; l.descuento = 0; return; }
  if (l.cantidad !== null && l.precio !== null) {
    const bruto = Math.round(l.cantidad * l.precio * 100);
    l.descuento = calcularDescuento(l.descuentoTexto, bruto);
    l.importe = bruto - l.descuento;
  }
}

function costeUnidad(l) {
  const uds = (l.cantidad || 0) * (l.bulto || 1);
  if (l.regalo || !uds || typeof l.importe !== "number") return null;
  return Math.round(l.importe / uds);
}

async function pintarNueva(cont) {
  try { await cargarProveedores(); } catch (e) { proveedoresCache = proveedoresCache || []; }
  try { albaranesPendientes = await cargarAlbaranesPendientes(); } catch (e) { albaranesPendientes = []; }
  const b = borrador;
  const adj = b.adjunto;
  const esAlb = b.tipo === "albaran";
  const prov = buscarProveedor(b.proveedorNombre, b.cif);
  const albDelProv = albaranesPendientes.filter((a) => !prov || a.proveedorId === prov.id || a.proveedorNombre.toLowerCase() === b.proveedorNombre.trim().toLowerCase());

  cont.innerHTML = `<div id="nRaiz">
    <div class="panel">
      <h2>Foto o PDF</h2>
      <label class="boton-archivo" for="nCamara">Hacer foto</label>
      <input id="nCamara" type="file" accept="image/*" capture="environment" hidden>
      <label class="boton-archivo sec" for="nArchivo">Elegir foto o PDF del móvil</label>
      <input id="nArchivo" type="file" accept="image/*,application/pdf" hidden>
      ${adj ? (adj.tipo === "application/pdf"
        ? `<p style="margin-bottom:0">PDF: ${esc(adj.nombre)}${adj.guardable ? "" : ' <span class="badge pendiente">se guardará la primera página</span>'}</p>${adj.paginas ? `<img class="foto-previa" alt="Primera página del PDF" src="data:image/jpeg;base64,${adj.paginas[0]}">` : ""}`
        : `<img class="foto-previa" alt="Foto del documento" src="data:${adj.tipo};base64,${adj.datos}">`) : ""}
      ${leyendo ? `<div class="estado neutro" id="nProgreso">Leyendo el documento… No salgas de la app.</div>` : ""}
      ${adj && !leyendo ? `<button class="sec" id="nReleer" type="button">Volver a leer con IA</button>` : ""}
      <small class="nota">También puedes rellenarlo a mano sin foto.</small>
    </div>

    <div class="panel">
      <h2>Datos</h2>
      <label for="nTipo">Tipo de documento</label>
      <select id="nTipo" data-campo="tipo">
        <option value="factura" ${!esAlb ? "selected" : ""}>Factura (o albarán-factura)</option>
        <option value="albaran" ${esAlb ? "selected" : ""}>Albarán (la factura llegará después)</option>
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
      ${!esAlb && albDelProv.length ? `
        <label for="nAlbaran">¿Es la factura de un albarán ya registrado?</label>
        <select id="nAlbaran" data-campo="albaranId">
          <option value="">No</option>
          ${albDelProv.map((a) => `<option value="${esc(a.id)}" ${a.id === b.albaranId ? "selected" : ""}>Albarán ${esc(a.numero)} del ${esc(fechaCorta(a.fecha))}, ${eur(a.total)}</option>`).join("")}
        </select>
        <small class="nota">Si eliges un albarán, sus productos no se vuelven a sumar al stock y el gasto solo cuenta una vez.</small>` : ""}
    </div>

    <div class="panel">
      <h2>Productos</h2>
      <div id="nLineas">${htmlLineas()}</div>
      <button class="sec" id="nAnadirLinea" type="button">Añadir producto</button>
    </div>

    <div class="panel">
      <h2>Cargos extra</h2>
      <small class="nota" style="margin-top:0">Lo que se suma aparte de los productos: punto verde, GTR, GST, portes… Solo si no va ya dentro del importe de un producto.</small>
      <div id="nCargos" style="margin-top:10px">${htmlCargos()}</div>
      <datalist id="nListaCargos">${CARGOS_HABITUALES.map((c) => `<option value="${esc(c)}"></option>`).join("")}</datalist>
      <button class="sec" id="nAnadirCargo" type="button">Añadir cargo</button>
    </div>

    <div class="panel">
      <h2>Totales</h2>
      <div class="resumen" id="nTotales"></div>
      <label for="nTotalPapel">Total que pone el documento (€)</label>
      <input id="nTotalPapel" inputmode="decimal" data-campo="totalFactura" value="${b.totalFactura === null ? "" : centimosATexto(b.totalFactura)}">
      <div id="nAvisoTotal"></div>
    </div>

    <div class="panel">
      <h2>Pago</h2>
      <div class="opciones-pago">
        ${esAlb ? `<label><input type="radio" name="nPago" value="conFactura" ${b.formaPago === "conFactura" ? "checked" : ""}> Se pagará con la factura</label>` : ""}
        <label><input type="radio" name="nPago" value="cajaRoja" ${b.formaPago === "cajaRoja" ? "checked" : ""}> Pagado en efectivo con la caja roja</label>
        <label><input type="radio" name="nPago" value="banco" ${b.formaPago === "banco" ? "checked" : ""}> Ya pagado por banco o tarjeta</label>
        ${!esAlb ? `<label><input type="radio" name="nPago" value="pendiente" ${b.formaPago === "pendiente" ? "checked" : ""}> Pendiente de pago (giro, recibo, transferencia)</label>` : ""}
      </div>
      <div id="nVencCaja" class="${b.formaPago === "pendiente" ? "" : "oculto"}">
        <label for="nVenc">Fecha prevista de pago</label>
        <input id="nVenc" type="date" data-campo="vencimiento" value="${esc(b.vencimiento)}">
      </div>
      <div id="nAvisoPago"></div>
      <label for="nObs">Observaciones (opcional)</label>
      <textarea id="nObs" data-campo="observaciones" placeholder="Faltaba una caja, viene un abono…">${esc(b.observaciones)}</textarea>
      <button id="nGuardar" type="button">Guardar</button>
      <button class="sec" id="nDescartar" type="button">Empezar de nuevo</button>
    </div>
  </div>`;

  const alElegir = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) cargarArchivo(f, cont); };
  $("nCamara").addEventListener("change", alElegir);
  $("nArchivo").addEventListener("change", alElegir);
  if ($("nReleer")) $("nReleer").addEventListener("click", () => leerConIA(cont));

  $("nRaiz").addEventListener("input", (e) => alEscribir(e, cont));
  $("nRaiz").addEventListener("change", (e) => alEscribir(e, cont));

  $("nAnadirLinea").addEventListener("click", () => {
    borrador.lineas.push(lineaVacia());
    $("nLineas").innerHTML = htmlLineas();
    actualizarTotales();
  });
  $("nLineas").addEventListener("click", (e) => {
    if (!e.target.classList.contains("lQuitar")) return;
    borrador.lineas.splice(Number(e.target.closest(".linea").dataset.i), 1);
    $("nLineas").innerHTML = htmlLineas();
    actualizarTotales();
  });
  $("nAnadirCargo").addEventListener("click", () => {
    borrador.cargos.push({ concepto: "", importe: null, iva: 21 });
    $("nCargos").innerHTML = htmlCargos();
    actualizarTotales();
  });
  $("nCargos").addEventListener("click", (e) => {
    if (!e.target.classList.contains("cQuitar")) return;
    borrador.cargos.splice(Number(e.target.closest(".cargo").dataset.i), 1);
    $("nCargos").innerHTML = htmlCargos();
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

function alEscribir(e, cont) {
  const t = e.target;
  if (t.name === "nPago") {
    borrador.formaPago = t.value;
    $("nVencCaja").classList.toggle("oculto", t.value !== "pendiente");
    if (t.value === "pendiente" && !borrador.vencimiento) { borrador.vencimiento = sumarDias(borrador.fecha, 7); $("nVenc").value = borrador.vencimiento; }
    actualizarTotales();
    return;
  }
  const linea = t.closest && t.closest(".linea");
  if (linea) {
    const l = borrador.lineas[Number(linea.dataset.i)];
    if (!l) return;
    if (t.classList.contains("lDesc")) l.descripcion = t.value;
    if (t.classList.contains("lIva")) l.iva = Number(t.value);
    if (t.classList.contains("lCant")) l.cantidad = num(t.value);
    if (t.classList.contains("lBulto")) l.bulto = num(t.value) || 1;
    if (t.classList.contains("lPrecio")) l.precio = num(t.value);
    if (t.classList.contains("lDto")) l.descuentoTexto = t.value;
    if (t.classList.contains("lRegalo")) {
      l.regalo = t.checked;
      linea.classList.toggle("regalo", l.regalo);
    }
    if (t.classList.contains("lImporte")) {
      l.importe = cent(t.value);
    } else if (!t.classList.contains("lDesc") && !t.classList.contains("lIva") && !t.classList.contains("lBulto")) {
      const antes = l.importe;
      recalcularLinea(l);
      if (l.importe !== antes) linea.querySelector(".lImporte").value = l.importe === null ? "" : centimosATexto(l.importe);
    }
    const cu = costeUnidad(l);
    linea.querySelector(".lCoste").textContent = cu === null ? "" : eur(cu) + " por unidad";
    actualizarTotales();
    return;
  }
  const cargo = t.closest && t.closest(".cargo");
  if (cargo) {
    const c = borrador.cargos[Number(cargo.dataset.i)];
    if (!c) return;
    if (t.classList.contains("cConcepto")) c.concepto = t.value;
    if (t.classList.contains("cImporte")) c.importe = cent(t.value);
    if (t.classList.contains("cIva")) c.iva = Number(t.value);
    actualizarTotales();
    return;
  }
  const campo = t.dataset && t.dataset.campo;
  if (!campo) return;
  if (campo === "totalFactura") borrador.totalFactura = cent(t.value);
  else borrador[campo] = t.value;
  // Cambios que necesitan volver a pintar el formulario
  if (e.type === "change" && (campo === "tipo" || campo === "proveedorNombre" || campo === "albaranId")) {
    if (campo === "tipo") {
      if (t.value === "albaran") { borrador.albaranId = ""; if (borrador.formaPago === "pendiente") borrador.formaPago = "conFactura"; }
      else if (borrador.formaPago === "conFactura") borrador.formaPago = "";
    }
    if (campo === "proveedorNombre") {
      const p = buscarProveedor(t.value, "");
      if (p) {
        if (!borrador.cif && p.cif) borrador.cif = p.cif;
        if (!borrador.formaPago && p.formaPagoHabitual) borrador.formaPago = borrador.tipo === "albaran" ? "conFactura" : (p.formaPagoHabitual === "efectivo" ? "cajaRoja" : "pendiente");
      }
    }
    pintarNueva(cont);
    return;
  }
  actualizarTotales();
}

function opcionesIva(sel) {
  return [...new Set([...TIPOS_IVA, sel])].map((t) => `<option value="${t}" ${t === sel ? "selected" : ""}>${t}</option>`).join("");
}

function htmlLineas() {
  if (!borrador.lineas.length) {
    return '<p class="suave" style="margin-top:0">Se rellenan solos al leer el documento. También puedes añadirlos a mano.</p>';
  }
  return borrador.lineas.map((l, i) => {
    const cu = costeUnidad(l);
    return `
      <div class="linea ${l.regalo ? "regalo" : ""}" data-i="${i}">
        <input class="lDesc" value="${esc(l.descripcion)}" placeholder="Producto">
        <div class="tres">
          <div><label>Cantidad</label><input class="lCant" inputmode="decimal" value="${esc(textoNum(l.cantidad))}"></div>
          <div><label>Uds. por caja</label><input class="lBulto" inputmode="numeric" value="${esc(textoNum(l.bulto || 1))}"></div>
          <div><label>IVA %</label><select class="lIva">${opcionesIva(l.iva)}</select></div>
        </div>
        <div class="tres">
          <div><label>Precio (sin dto.)</label><input class="lPrecio" inputmode="decimal" value="${esc(textoNum(l.precio))}"></div>
          <div><label>Descuento</label><input class="lDto" value="${esc(l.descuentoTexto || (l.descuento ? centimosATexto(l.descuento) : ""))}" placeholder="€ o 15%"></div>
          <div><label>Importe neto</label><input class="lImporte" inputmode="decimal" value="${l.importe === null ? "" : centimosATexto(l.importe)}"></div>
        </div>
        <div class="pie">
          <label class="check"><input type="checkbox" class="lRegalo" ${l.regalo ? "checked" : ""}> Regalo</label>
          <small class="lCoste">${cu === null ? "" : eur(cu) + " por unidad"}</small>
          <button type="button" class="lQuitar">Quitar</button>
        </div>
      </div>`;
  }).join("");
}

function htmlCargos() {
  if (!borrador.cargos.length) return "";
  return borrador.cargos.map((c, i) => `
    <div class="cargo" data-i="${i}">
      <div><label>Concepto</label><input class="cConcepto" list="nListaCargos" value="${esc(c.concepto)}"></div>
      <div><label>Importe €</label><input class="cImporte" inputmode="decimal" value="${c.importe === null ? "" : centimosATexto(c.importe)}"></div>
      <div><label>IVA %</label><select class="cIva">${opcionesIva(c.iva)}</select></div>
      <button type="button" class="cQuitar">Quitar cargo</button>
    </div>`).join("");
}

function actualizarTotales() {
  const caja = $("nTotales");
  if (!caja) return;
  const t = calcularTotales(borrador.lineas, borrador.cargos);
  const papel = borrador.basesPapel || [];
  caja.innerHTML = t.bases.length
    ? t.bases.map((b) => {
        const p = papel.find((x) => x.tipoIva === b.tipoIva);
        const distinto = p && (Math.abs(p.base - b.base) > 2 || Math.abs(p.cuota - b.cuota) > 2);
        return `<div><span>Base al ${b.tipoIva} % / IVA${distinto ? ` <span class="badge vencida">el papel dice ${eur(p.base)} / ${eur(p.cuota)}</span>` : ""}</span><strong>${eur(b.base)} / ${eur(b.cuota)}</strong></div>`;
      }).join("") + `<div><span>Total calculado</span><strong>${eur(t.total)}</strong></div>`
    : '<div><span class="suave">Sin importes todavía</span></div>';
  const aviso = $("nAvisoTotal");
  if (borrador.totalFactura !== null && t.bases.length) {
    const dif = borrador.totalFactura - t.total;
    aviso.innerHTML = Math.abs(dif) <= 5
      ? `<div class="estado ok">Cuadra con el total del documento</div>`
      : `<div class="estado sobra" style="font-weight:400">No cuadra con el total del documento (diferencia ${eur(dif)}). Revisa productos, descuentos, cargos extra e IVA.</div>`;
  } else {
    aviso.innerHTML = "";
  }
  const total = borrador.totalFactura ?? t.total;
  const alb = albaranesPendientes.find((a) => a.id === borrador.albaranId);
  let avisoPago = "";
  if (alb && alb.estado === "pagada") avisoPago = `<div class="estado ok" style="font-weight:400">El albarán ya se pagó (${alb.pagadaDesde === "cajaRoja" ? "caja roja" : "banco"}): esta factura quedará como pagada y no se descontará otra vez.</div>`;
  else if (borrador.formaPago === "cajaRoja" && total >= LIMITE_EFECTIVO) avisoPago = `<div class="estado mal" style="font-weight:400">Atención: entre empresas no se puede pagar en efectivo una operación de 1.000 € o más. Mejor por banco.</div>`;
  $("nAvisoPago").innerHTML = avisoPago;
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
function blobABase64(blob) {
  return new Promise((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] || "");
    r.onerror = () => ko(new Error("No se ha podido leer la imagen"));
    r.readAsDataURL(blob);
  });
}
async function abrirImagen(file) {
  try {
    if (window.createImageBitmap) return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (e) { /* probamos el método clásico */ }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
async function comprimirImagen(file) {
  try {
    const img = await abrirImagen(file);
    const ancho = img.width, alto = img.height;
    if (!ancho || !alto) throw new Error("imagen vacía");
    let max = 1600, calidad = 0.75;
    for (let intento = 0; intento < 5; intento++) {
      const factor = Math.min(1, max / Math.max(ancho, alto));
      const c = document.createElement("canvas");
      c.width = Math.round(ancho * factor);
      c.height = Math.round(alto * factor);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", calidad));
      if (blob && blob.size > 2000 && blob.type === "image/jpeg") {
        const datos = await blobABase64(blob);
        if (datos.startsWith("/9j/") && datos.length < 850000) return { datos, tipo: "image/jpeg" };
      }
      max = Math.round(max * 0.8);
      calidad = Math.max(0.5, calidad - 0.07);
    }
    throw new Error("no se ha podido comprimir");
  } catch (e) {
    if (file.size && file.size < 3 * 1024 * 1024 && /^image\/(jpeg|png|webp)$/.test(file.type)) {
      return { datos: await blobABase64(file), tipo: file.type };
    }
    throw new Error("Este móvil no ha podido procesar la foto (" + Math.round(file.size / 1024) + " KB, " + (file.type || "tipo desconocido") + "). Prueba con una captura de pantalla del documento.");
  }
}
async function pdfAImagenes(base64) {
  const pdfjs = await import(PDFJS + "pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.mjs";
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  const paginas = [];
  for (let i = 1; i <= Math.min(pdf.numPages, MAX_PAGINAS_PDF); i++) {
    const pagina = await pdf.getPage(i);
    const base = pagina.getViewport({ scale: 1 });
    const escala = Math.min(2.5, 1600 / Math.max(base.width, base.height));
    const vista = pagina.getViewport({ scale: escala });
    const c = document.createElement("canvas");
    c.width = Math.round(vista.width);
    c.height = Math.round(vista.height);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    await pagina.render({ canvasContext: ctx, viewport: vista }).promise;
    const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.8));
    if (blob && blob.size > 2000) paginas.push(await blobABase64(blob));
  }
  if (!paginas.length) throw new Error("PDF sin páginas legibles");
  return paginas;
}
async function cargarArchivo(file, cont) {
  try {
    if (file.type === "application/pdf") {
      const datos = await leerComoBase64(file);
      borrador.adjunto = { tipo: "application/pdf", datos, nombre: file.name, guardable: datos.length < 900000 };
    } else {
      const { datos, tipo } = await comprimirImagen(file);
      borrador.adjunto = { tipo, datos, nombre: file.name, guardable: datos.length < 900000 };
    }
  } catch (e) {
    return mostrar(e.message, "mal");
  }
  await leerConIA(cont);
}

let modeloElegido = (() => {
  try {
    const guardado = localStorage.getItem("modeloIA");
    return guardado && !MODELOS_IA.includes(guardado) ? guardado : MODELOS_IA[0];
  } catch (e) { return MODELOS_IA[0]; }
})();
const modelosCreados = {};
async function obtenerModelo(nombre, pensarPoco) {
  const clave = nombre + (pensarPoco ? "-rapido" : "");
  if (modelosCreados[clave]) return modelosCreados[clave];
  const { initializeApp, getApps } = await import(SDK_IA + "firebase-app.js");
  const iaSdk = await import(SDK_IA + "firebase-ai.js");
  const appIA = getApps().find((a) => a.name === "lector-facturas") || initializeApp(CONFIG_IA, "lector-facturas");
  const ai = iaSdk.getAI(appIA, { backend: new iaSdk.GoogleAIBackend() });
  const generationConfig = { responseMimeType: "application/json" };
  if (pensarPoco) generationConfig.thinkingConfig = { thinkingLevel: iaSdk.ThinkingLevel ? iaSdk.ThinkingLevel.LOW : "LOW" };
  modelosCreados[clave] = iaSdk.getGenerativeModel(ai, { model: nombre, generationConfig });
  return modelosCreados[clave];
}

function mensajeErrorIA(e) {
  const m = String((e && e.message) || e);
  const tamano = borrador.adjunto ? " Archivo: " + Math.round(borrador.adjunto.datos.length * 0.75 / 1024) + " KB." : "";
  if (/429|quota|RESOURCE_EXHAUSTED/i.test(m)) return "Se ha agotado por hoy el límite gratuito de lecturas automáticas. Prueba más tarde o rellénalo a mano.";
  if (/Failed to fetch|network|fetch-error|ERR_/i.test(m)) return "No se ha podido enviar el documento a la IA. Pulsa «Volver a leer con IA» y no salgas de la app mientras lee." + tamano + " Detalle: " + m.slice(-80);
  if (/JSON/i.test(m)) return "La IA ha devuelto una respuesta que no se entiende. Prueba con una foto más nítida o rellénalo a mano.";
  return "No se ha podido leer automáticamente (" + m.slice(0, 160) + "). Prueba otra foto o rellénalo a mano.";
}

const INSTRUCCIONES_IA = `Eres un asistente que lee facturas y albaranes de proveedores de un bar en España (Sweet Dreams, CIF E47761556).
Devuelve SOLO un objeto JSON, sin texto adicional, con esta forma:
{"tipo":"factura","proveedor":{"nombre":"","cif":"","telefono":"","email":""},"numero":"","fecha":"AAAA-MM-DD","formaPago":"","vencimiento":"","lineas":[{"descripcion":"","cantidad":0,"unidadesPorBulto":1,"precioUnitario":0,"descuento":0,"importe":0,"iva":21,"regalo":false}],"cargos":[{"concepto":"","importe":0,"iva":21}],"impuestos":[{"tipoIva":21,"base":0,"cuota":0}],"total":0}
Reglas:
- "tipo": "albaran" solo si es un albarán por el que llegará una factura aparte. Si es factura o "albarán-factura" (ALB-FACT), pon "factura".
- El proveedor es la empresa que emite el documento, nunca Sweet Dreams.
- Importes en euros, números con punto decimal, sin símbolo. Todos SIN IVA salvo "total".
- Cada producto es una línea. "cantidad" es lo que se factura (cajas, barriles, unidades). "unidadesPorBulto" son las unidades que trae cada caja si aparece (C24 = 24, "24 x 1/3" = 24, "*35" = 35, "SUBUNIDADES 72" con cantidad 3 = 24); si no aparece, 1.
- "precioUnitario" es el precio de cada caja o unidad facturada ANTES de descuento. "descuento" es el descuento total de la línea en euros (si viene en %, calcula los euros). "importe" es el neto final de la línea (cantidad × precio − descuento).
- Si una línea tiene filas de detalle (Dto. fijo, punto verde, subunidades/neto), júntalas en una sola línea: usa como "importe" el neto final de ese producto, incluido su punto verde.
- "regalo": true si la línea es un regalo o va sin cargo (importe 0).
- "cargos": importes que se suman a la base fuera de los productos (GTR, GST, punto verde total, portes, envases) solo si NO están ya dentro del importe de algún producto. La suma de los importes de las líneas más los cargos debe dar la base imponible total del documento.
- "impuestos": las bases y cuotas de IVA tal como vienen impresas. "total": el total final a pagar.
- "formaPago": copia lo que diga (contado, giro, recibo bancario, transferencia…). "vencimiento" en AAAA-MM-DD si aparece; si dice "X días fecha factura", súmalos a la fecha.
- Ignora productos en depósito, envases entregados o retirados y material prestado.
- Si un dato no aparece o no se lee bien, déjalo vacío o en 0. No inventes nada.`;

async function leerConIA(cont) {
  const adj = borrador.adjunto;
  if (!adj || leyendo) return;
  leyendo = true;
  await pintarNueva(cont);

  let bloqueo = null;
  try { if (navigator.wakeLock) bloqueo = await navigator.wakeLock.request("screen"); } catch (e) { /* no pasa nada */ }
  const inicio = Date.now();
  const reloj = setInterval(() => {
    const el = document.getElementById("nProgreso");
    if (el) el.textContent = `Leyendo el documento… ${Math.round((Date.now() - inicio) / 1000)} s. No salgas de la app.`;
  }, 1000);

  let partes = [{ inlineData: { data: adj.datos, mimeType: adj.tipo } }];
  if (adj.tipo === "application/pdf") {
    try {
      if (!adj.paginas) adj.paginas = await pdfAImagenes(adj.datos);
      partes = adj.paginas.map((d) => ({ inlineData: { data: d, mimeType: "image/jpeg" } }));
    } catch (e) { /* se envía el PDF original */ }
  }

  let nombre = modeloElegido;
  let pensarPoco = true;
  let reintentosRed = 0;
  const probados = new Set();
  try {
    for (let intento = 0; intento < 6; intento++) {
      try {
        const modelo = await obtenerModelo(nombre, pensarPoco);
        const res = await modelo.generateContent([INSTRUCCIONES_IA, ...partes]);
        const texto = res.response.text().replace(/```json|```/g, "").trim();
        aplicarLectura(JSON.parse(texto));
        borrador.leidaConIA = true;
        if (nombre !== modeloElegido) {
          modeloElegido = nombre;
          try { localStorage.setItem("modeloIA", nombre); } catch (e) { /* sin memoria local */ }
        }
        leyendo = false;
        await pintarNueva(cont);
        mostrar(`Leído en ${Math.round((Date.now() - inicio) / 1000)} s. Revisa los datos antes de guardar.`, "ok");
        return;
      } catch (e) {
        const m = String((e && e.message) || e);
        probados.add(nombre);
        const recomendado = m.match(/use models\/([a-z0-9.\-]+)/i);
        if (recomendado && !probados.has(recomendado[1])) { nombre = recomendado[1]; continue; }
        if (/404|not found|no longer available|not supported|429|quota|RESOURCE_EXHAUSTED/i.test(m)) {
          const siguiente = MODELOS_IA.find((x) => !probados.has(x));
          if (siguiente) { nombre = siguiente; continue; }
        }
        if (pensarPoco && /thinking/i.test(m)) { pensarPoco = false; continue; }
        if (/Failed to fetch|network|fetch-error|503|UNAVAILABLE|overloaded/i.test(m) && reintentosRed < 2) {
          reintentosRed++;
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        throw e;
      }
    }
    throw new Error("No hay ningún modelo de IA disponible");
  } catch (e) {
    leyendo = false;
    await pintarNueva(cont);
    mostrar(mensajeErrorIA(e), "mal");
  } finally {
    clearInterval(reloj);
    try { if (bloqueo) await bloqueo.release(); } catch (e) { /* ya liberado */ }
  }
}

function aplicarLectura(d) {
  const b = borrador;
  if (d.tipo) b.tipo = /albar/i.test(d.tipo) && !/fact/i.test(d.tipo) ? "albaran" : "factura";
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
      const descuento = cent(l.descuento) || 0;
      const regalo = l.regalo === true || /regalo|sin cargo/i.test(String(l.descripcion || ""));
      let importe = cent(l.importe);
      if (importe === null && cantidad !== null && precio !== null) importe = Math.round(cantidad * precio * 100) - descuento;
      const iva = num(l.iva);
      return {
        descripcion: String(l.descripcion || "").replace(/\s*regalo\s*$/i, "").trim(),
        cantidad,
        bulto: num(l.unidadesPorBulto) > 1 ? num(l.unidadesPorBulto) : 1,
        precio,
        descuentoTexto: descuento ? centimosATexto(descuento) : "",
        descuento,
        importe: regalo ? 0 : importe,
        iva: iva === null ? 21 : Math.round(iva),
        regalo
      };
    }).filter((l) => l.descripcion || l.importe);
  }
  if (Array.isArray(d.cargos)) {
    b.cargos = d.cargos.map((c) => ({ concepto: String(c.concepto || "").trim(), importe: cent(c.importe), iva: num(c.iva) === null ? 21 : Math.round(num(c.iva)) }))
      .filter((c) => c.importe);
  }
  if (Array.isArray(d.impuestos)) {
    b.basesPapel = d.impuestos.map((x) => ({ tipoIva: Math.round(num(x.tipoIva) || 0), base: cent(x.base) || 0, cuota: cent(x.cuota) || 0 })).filter((x) => x.base);
  }
  const total = cent(d.total);
  if (total !== null && total > 0) b.totalFactura = total;

  // Forma de pago: lo que diga el papel; si no, la habitual del proveedor
  const fp = String(d.formaPago || "").toLowerCase();
  const conocido = buscarProveedor(b.proveedorNombre, b.cif);
  if (conocido) b.proveedorNombre = conocido.nombre;
  if (!b.formaPago) {
    if (b.tipo === "albaran") b.formaPago = "conFactura";
    else if (/contado|efectivo|metálico|metalico/.test(fp)) b.formaPago = "cajaRoja";
    else if (/giro|recibo|banc|domicil|transfer|plazo/.test(fp)) b.formaPago = "pendiente";
    else if (conocido && conocido.formaPagoHabitual) b.formaPago = conocido.formaPagoHabitual === "efectivo" ? "cajaRoja" : "pendiente";
  }
  if (b.formaPago === "pendiente" && !b.vencimiento) b.vencimiento = sumarDias(b.fecha, 7);
}

// ---------- Guardar ----------
async function guardarFactura(cont) {
  const b = borrador;
  const u = estado.usuario;
  const t = calcularTotales(b.lineas, b.cargos);
  const total = b.totalFactura ?? t.total;
  const esAlb = b.tipo === "albaran";
  const nombreDoc = esAlb ? "el albarán" : "la factura";

  if (!b.proveedorNombre.trim()) return mostrar("Falta el proveedor.", "mal");
  if (!b.numero.trim()) return mostrar("Falta el número.", "mal");
  if (!esFecha(b.fecha)) return mostrar("Falta la fecha.", "mal");
  if (b.lineas.some((l) => !l.regalo && (l.importe === null || isNaN(l.importe)))) return mostrar("Hay productos sin importe. Rellénalo, márcalo como regalo o quítalo.", "mal");
  if (b.cargos.some((c) => c.importe === null || isNaN(c.importe))) return mostrar("Hay un cargo extra sin importe.", "mal");
  if (!total || total <= 0) return mostrar("Falta el total.", "mal");
  if (!b.formaPago) return mostrar("Indica cómo se ha pagado o si está pendiente.", "mal");

  if (b.totalFactura !== null && t.bases.length && Math.abs(b.totalFactura - t.total) > 5 &&
      !confirm("Los importes no cuadran con el total del documento. ¿Guardar de todas formas?")) return;
  if (b.formaPago === "cajaRoja" && total >= LIMITE_EFECTIVO &&
      !confirm("Es un pago en efectivo de 1.000 € o más, y entre empresas no está permitido. ¿Seguro que quieres guardarlo así?")) return;

  if (u.socio) {
    try {
      const s = await getDocs(query(collection(db, "facturas"), where("numero", "==", b.numero.trim())));
      let repetida = false;
      s.forEach((d) => {
        const f = d.data();
        if (!f.anulada && f.tipo === b.tipo && (normCif(f.cif) === normCif(b.cif) || f.proveedorNombre.toLowerCase() === b.proveedorNombre.trim().toLowerCase())) repetida = true;
      });
      if (repetida && !confirm(`Ya hay ${nombreDoc} de este proveedor con ese número. ¿Guardarlo otra vez?`)) return;
    } catch (e) { /* si falla la comprobación, seguimos */ }
  }

  const albaran = !esAlb && b.albaranId ? albaranesPendientes.find((a) => a.id === b.albaranId) : null;
  if (!confirm(`¿Guardar ${nombreDoc} ${b.numero} de ${b.proveedorNombre} por ${eur(total)}?${albaran ? `\n\nQueda vinculada al albarán ${albaran.numero}.` : ""}`)) return;

  const lote = writeBatch(db);
  const prov = buscarProveedor(b.proveedorNombre, b.cif);
  let provId;
  if (prov) {
    provId = prov.id;
  } else {
    const ref = doc(collection(db, "proveedores"));
    provId = ref.id;
    lote.set(ref, {
      nombre: b.proveedorNombre.trim(), cif: normCif(b.cif),
      telefono: b.provTelefono || "", email: b.provEmail || "",
      diasReparto: "", formaPagoHabitual: b.formaPago === "cajaRoja" ? "efectivo" : "banco",
      notas: "", activo: true,
      autorUid: u.uid, autorNombre: u.nombre, creadoEn: serverTimestamp()
    });
  }

  const refFactura = doc(collection(db, "facturas"));
  let guardar = null;
  if (b.adjunto && b.adjunto.guardable) guardar = { tipo: b.adjunto.tipo, datos: b.adjunto.datos };
  else if (b.adjunto && b.adjunto.paginas && b.adjunto.paginas[0] && b.adjunto.paginas[0].length < 900000) guardar = { tipo: "image/jpeg", datos: b.adjunto.paginas[0] };
  if (guardar) {
    lote.set(doc(db, "adjuntos", refFactura.id), {
      facturaId: refFactura.id, tipo: guardar.tipo, datos: guardar.datos,
      autorUid: u.uid, creadoEn: serverTimestamp()
    });
  }

  // Estado de pago
  let estadoPago, pagadaDesde = null, fechaPago = null, pagado = false;
  if (albaran && albaran.estado === "pagada") {
    estadoPago = "pagada"; pagadaDesde = "albaran"; fechaPago = albaran.fechaPago || hoy();
  } else if (b.formaPago === "conFactura") {
    estadoPago = "esperaFactura";
  } else if (b.formaPago === "pendiente") {
    estadoPago = "pendiente";
  } else {
    estadoPago = "pagada"; pagadaDesde = b.formaPago; fechaPago = hoy(); pagado = true;
  }

  lote.set(refFactura, {
    tipo: b.tipo,
    proveedorId: provId,
    proveedorNombre: b.proveedorNombre.trim(),
    cif: normCif(b.cif),
    numero: b.numero.trim(),
    fecha: b.fecha,
    lineas: b.lineas.map((l) => ({
      descripcion: l.descripcion.trim(), cantidad: l.cantidad, bulto: l.bulto || 1,
      precio: l.precio, descuento: l.regalo ? 0 : (l.descuento || 0), descuentoTexto: l.descuentoTexto || "",
      importe: l.regalo ? 0 : l.importe, iva: l.iva, regalo: !!l.regalo
    })),
    cargos: b.cargos.map((c) => ({ concepto: c.concepto.trim() || "Cargo", importe: c.importe, iva: c.iva })),
    bases: t.bases,
    totalBase: t.totalBase,
    totalIva: t.totalIva,
    totalCalculado: t.total,
    total,
    estado: estadoPago,
    pagadaDesde,
    fechaPago,
    pagoEn: pagado ? serverTimestamp() : null,
    pagoPor: pagado ? u.nombre : null,
    vencimiento: estadoPago === "pendiente" ? (b.vencimiento || null) : null,
    albaranId: albaran ? albaran.id : null,
    facturaId: esAlb ? null : null,
    observaciones: b.observaciones.trim(),
    leidaConIA: b.leidaConIA,
    adjunto: guardar ? guardar.tipo : null,
    anulada: false,
    autorUid: u.uid,
    autorNombre: u.nombre,
    creadoEn: serverTimestamp()
  });
  if (albaran) {
    lote.update(doc(db, "facturas", albaran.id), { facturaId: refFactura.id, facturadaEn: serverTimestamp() });
  }

  $("nGuardar").disabled = true;
  try {
    await lote.commit();
    proveedoresCache = null;
    const resumen = { ...b, total, estadoPago };
    borrador = borradorVacio();
    const textoPago = {
      pagada: pagadaDesde === "albaran" ? "Pagada con el albarán" : pagadaDesde === "cajaRoja" ? "Efectivo, caja roja" : "Pagada por banco",
      pendiente: "Pendiente de pago",
      esperaFactura: "Se pagará con la factura"
    }[estadoPago];
    cont.innerHTML = `
      <div class="panel">
        <h2>${esAlb ? "Albarán guardado" : "Factura guardada"}</h2>
        <div class="resumen">
          <div><span>Proveedor</span><strong>${esc(resumen.proveedorNombre)}</strong></div>
          <div><span>Número</span><strong>${esc(resumen.numero)}</strong></div>
          <div><span>Fecha</span><strong>${esc(fechaCorta(resumen.fecha))}</strong></div>
          <div><span>Total</span><strong>${eur(resumen.total)}</strong></div>
          <div><span>Pago</span><strong>${esc(textoPago)}</strong></div>
        </div>
        ${albaran ? `<p class="suave">Vinculada al albarán ${esc(albaran.numero)}: sus productos no se suman dos veces.</p>` : ""}
        ${esAlb ? `<p class="suave">Cuando llegue su factura, regístrala y elige este albarán en «¿Es la factura de un albarán ya registrado?».</p>` : ""}
        <a class="boton" href="#/compras/nueva">Registrar otra</a>
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
  if (esAlbaran(f)) {
    if (f.facturaId) return '<span class="badge pagada">facturado</span>';
    return '<span class="badge espera">esperando factura</span>';
  }
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
      <div class="sub"><span>${esAlbaran(f) ? "Albarán" : "Factura"} ${esc(f.numero)}</span><span>${esc(fechaCorta(f.fecha))}${extra}</span></div>
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
  let html = '<p class="suave" style="margin-top:0;line-height:1.5">La base y el IVA soportado salen solo de las facturas, que es lo que necesita la gestoría. El total de compras incluye también los albaranes que aún esperan su factura.</p>';
  Object.keys(meses).sort().reverse().forEach((m) => {
    const fiscales = meses[m].filter(esFiscal);
    const base = fiscales.reduce((a, f) => a + (f.totalBase || 0), 0);
    const iva = fiscales.reduce((a, f) => a + (f.totalIva || 0), 0);
    const sinFactura = meses[m].filter(albaranSinFactura).reduce((a, f) => a + f.total, 0);
    const total = meses[m].filter(cuentaComoGasto).reduce((a, f) => a + f.total, 0);
    const nombreMes = new Date(m + "-01T12:00:00").toLocaleDateString("es-ES", { month: "long", year: "numeric" });
    html += `
      <div class="semana">
        <h3>${esc(nombreMes.charAt(0).toUpperCase() + nombreMes.slice(1))}</h3>
        <div class="panel resumen" style="padding:6px 14px">
          <div><span>Base imponible (facturas)</span><strong>${eur(base)}</strong></div>
          <div><span>IVA soportado (facturas)</span><strong>${eur(iva)}</strong></div>
          ${sinFactura ? `<div><span>Albaranes sin factura</span><strong>${eur(sinFactura)}</strong></div>` : ""}
          <div><span>Total compras</span><strong>${eur(total)}</strong></div>
        </div>
        ${meses[m].map((f) => itemFactura(f)).join("")}
      </div>`;
  });
  cont.innerHTML = html;
}

// =============================================================
// PENDIENTES (socios): pagos y albaranes sin factura
// =============================================================
async function pintarPendientes(cont) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const [s, albaranes] = await Promise.all([
    getDocs(query(collection(db, "facturas"), where("estado", "==", "pendiente"))),
    cargarAlbaranesPendientes()
  ]);
  const lista = [];
  s.forEach((d) => { const f = { id: d.id, ...d.data() }; if (!f.anulada && !esAlbaran(f)) lista.push(f); });
  lista.sort((a, b) => (a.vencimiento || "9999").localeCompare(b.vencimiento || "9999"));
  const total = lista.reduce((a, f) => a + f.total, 0);
  const totalAlb = albaranes.reduce((a, f) => a + f.total, 0);
  cont.innerHTML = `
    <div class="panel resumen" style="padding:6px 14px">
      <div><span>Pendiente de pago</span><strong>${eur(total)}</strong></div>
      <div><span>Facturas pendientes</span><strong>${lista.length}</strong></div>
      <div><span>Albaranes esperando factura</span><strong>${albaranes.length} (${eur(totalAlb)})</strong></div>
    </div>
    <div class="semana"><h3>Facturas pendientes de pago</h3>
      ${lista.length ? lista.map((f) => itemFactura(f, f.vencimiento ? ", vence el " + esc(fechaCorta(f.vencimiento)) : "")).join("") : '<p class="suave">No hay nada pendiente de pago.</p>'}
    </div>
    <div class="semana"><h3>Albaranes esperando su factura</h3>
      ${albaranes.length ? albaranes.map((f) => itemFactura(f)).join("") : '<p class="suave">No hay albaranes esperando factura.</p>'}
    </div>`;
}

// =============================================================
// DETALLE (socios)
// =============================================================
async function pintarDetalleFactura(cont, id) {
  if (!id) { location.hash = "#/compras/facturas"; return; }
  const s = await getDoc(doc(db, "facturas", id));
  if (!s.exists()) { cont.innerHTML = '<div class="panel">No se ha encontrado ese documento.</div>'; return; }
  const f = { id, ...s.data() };
  const alb = esAlbaran(f);

  // Documento vinculado
  let vinculado = null;
  const otroId = alb ? f.facturaId : f.albaranId;
  if (otroId) {
    try { const o = await getDoc(doc(db, "facturas", otroId)); if (o.exists()) vinculado = { id: otroId, ...o.data() }; } catch (e) { /* sin datos */ }
  }
  let albaranesParaVincular = [];
  if (!alb && !f.albaranId && !f.anulada) {
    try { albaranesParaVincular = (await cargarAlbaranesPendientes()).filter((a) => a.proveedorId === f.proveedorId); } catch (e) { /* sin datos */ }
  }

  const lineas = (f.lineas || []).map((l) => {
    const bulto = l.bulto && l.bulto > 1 ? ` (${textoNum(l.bulto)} uds/caja)` : "";
    const detalle = l.regalo
      ? `${textoNum(l.cantidad)}${bulto} · regalo`
      : `${l.cantidad !== null && l.cantidad !== undefined ? textoNum(l.cantidad) + bulto + " × " + textoNum(l.precio) + " €" : ""}${l.descuento ? " − dto. " + eur(l.descuento) : ""} · IVA ${l.iva} %`;
    const cu = costeUnidad(l);
    return `<div><span>${esc(l.descripcion || "Producto")}${l.regalo ? '<span class="badge regalo">regalo</span>' : ""}<small>${esc(detalle)}${cu !== null && (l.bulto > 1 || l.descuento) ? ` · ${eur(cu)}/ud` : ""}</small></span><strong>${eur(l.importe || 0)}</strong></div>`;
  }).join("") || '<div><span class="suave">Sin detalle de productos</span></div>';
  const cargos = (f.cargos || []).map((c) => `<div><span>${esc(c.concepto)}<small>IVA ${c.iva} %</small></span><strong>${eur(c.importe)}</strong></div>`).join("");
  const bases = (f.bases || []).map((b) => `<div><span>Base al ${b.tipoIva} % / IVA</span><strong>${eur(b.base)} / ${eur(b.cuota)}</strong></div>`).join("");
  const desde = { cajaRoja: "Efectivo, caja roja", banco: "Banco o tarjeta", albaran: "Pagada con el albarán" };

  cont.innerHTML = `
    <a class="volver" href="#/compras/facturas">‹ Facturas</a>
    <div class="panel">
      <h2>${esc(f.proveedorNombre)}${etiquetaEstado(f)}</h2>
      <div class="resumen">
        <div><span>${alb ? "Albarán" : "Factura"}</span><strong>${esc(f.numero)}</strong></div>
        <div><span>Fecha</span><strong>${esc(fechaCorta(f.fecha))}</strong></div>
        <div><span>CIF</span><strong>${esc(f.cif || "—")}</strong></div>
        <div><span>Registrado por</span><strong>${esc(f.autorNombre)}, ${esc(horaDe(f.creadoEn))}</strong></div>
        ${vinculado ? `<div><span>${alb ? "Su factura" : "Su albarán"}</span><strong><a href="#/compras/factura/${encodeURIComponent(vinculado.id)}">${esc(vinculado.numero)}</a></strong></div>` : ""}
      </div>
      ${f.leidaConIA ? '<small class="nota">Datos leídos automáticamente y revisados al guardar.</small>' : ""}
      ${!alb && f.albaranId ? '<small class="nota">Sus productos ya se sumaron al stock con el albarán.</small>' : ""}
    </div>
    <div class="panel"><h2>Productos</h2><div class="tabla-lineas">${lineas}</div></div>
    ${cargos ? `<div class="panel"><h2>Cargos extra</h2><div class="tabla-lineas">${cargos}</div></div>` : ""}
    <div class="panel"><h2>Importes</h2><div class="resumen">
      ${bases}
      <div><span>Total</span><strong>${eur(f.total)}</strong></div>
      ${f.totalCalculado && Math.abs(f.totalCalculado - f.total) > 5 ? `<div><span>Total calculado</span><strong>${eur(f.totalCalculado)}</strong></div>` : ""}
    </div></div>
    <div class="panel"><h2>Pago</h2><div class="resumen">
      ${f.estado === "pagada"
        ? `<div><span>Pagada</span><strong>${esc(desde[f.pagadaDesde] || f.pagadaDesde || "")}</strong></div>
           <div><span>Fecha de pago</span><strong>${esc(fechaCorta(f.fechaPago))}${f.pagoPor ? " (" + esc(f.pagoPor) + ")" : ""}</strong></div>`
        : f.estado === "esperaFactura"
          ? `<div><span>Estado</span><strong>Se paga con su factura</strong></div>`
          : `<div><span>Estado</span><strong>Pendiente</strong></div>
             <div><span>Fecha prevista</span><strong>${esc(fechaCorta(f.vencimiento) || "Sin fecha")}</strong></div>`}
    </div>
    ${f.observaciones ? `<p style="margin-bottom:0"><strong>Observaciones:</strong> ${esc(f.observaciones)}</p>` : ""}
    </div>
    ${f.adjunto ? `<div class="panel"><h2>Documento original</h2><div id="dAdjunto"><button class="sec" id="dVerAdjunto" type="button">Ver ${f.adjunto === "application/pdf" ? "PDF" : "foto"}</button></div></div>` : ""}
    ${albaranesParaVincular.length ? `
      <div class="panel">
        <h2>Vincular a un albarán</h2>
        <p class="suave" style="margin-top:0">Si esta factura es de un albarán ya registrado, vincúlalos para no contar dos veces el gasto ni el stock.</p>
        <select id="dAlbaran">${albaranesParaVincular.map((a) => `<option value="${esc(a.id)}">Albarán ${esc(a.numero)} del ${esc(fechaCorta(a.fecha))}, ${eur(a.total)}</option>`).join("")}</select>
        <button class="sec" id="dVincular" type="button">Vincular</button>
      </div>` : ""}
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
        <p class="suave" style="margin-top:0">Solo si está repetido o mal registrado. No se borra: queda marcado como anulado con el motivo. Si había un error, anúlalo y vuelve a registrarlo bien.</p>
        <label for="dMotivo">Motivo</label>
        <input id="dMotivo" placeholder="Registrada dos veces">
        <button class="peligro" id="dAnular" type="button">Anular</button>
      </div>` : `<div class="panel"><h2>Anulado</h2><p style="margin:0">${esc(f.motivoAnulacion || "")} (${esc(f.anuladaPor || "")})</p></div>`}`;

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
          $("dAdjunto").innerHTML = `<img class="foto-previa" alt="Foto del documento" src="data:${ad.tipo};base64,${ad.datos}">`;
        }
      } catch (e) {
        $("dAdjunto").innerHTML = `<p class="suave">No se ha podido cargar: ${esc(traducirError(e.code || e.message))}</p>`;
      }
    });
  }

  if ($("dVincular")) {
    $("dVincular").addEventListener("click", async () => {
      const a = albaranesParaVincular.find((x) => x.id === $("dAlbaran").value);
      if (!a || !confirm(`¿Vincular esta factura al albarán ${a.numero}?`)) return;
      try {
        const lote = writeBatch(db);
        const cambios = { albaranId: a.id };
        if (a.estado === "pagada" && f.estado === "pendiente") Object.assign(cambios, { estado: "pagada", pagadaDesde: "albaran", fechaPago: a.fechaPago || hoy() });
        lote.update(doc(db, "facturas", id), cambios);
        lote.update(doc(db, "facturas", a.id), { facturaId: id, facturadaEn: serverTimestamp() });
        await lote.commit();
        await pintarDetalleFactura(cont, id);
        mostrar("Vinculados.", "ok");
      } catch (e) {
        mostrar("No se ha podido vincular: " + traducirError(e.code || e.message), "mal");
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
        mostrar("Marcada como pagada.", "ok");
      } catch (e) {
        mostrar("No se ha podido guardar: " + traducirError(e.code || e.message), "mal");
      }
    });
  }

  if ($("dAnular")) {
    $("dAnular").addEventListener("click", async () => {
      const motivo = $("dMotivo").value.trim();
      if (!motivo) return mostrar("Escribe el motivo de la anulación.", "mal");
      if (!confirm("¿Anular? Quedará registrado como anulado y no contará en los totales.")) return;
      try {
        await updateDoc(doc(db, "facturas", id), {
          anulada: true, motivoAnulacion: motivo, anuladaPor: estado.usuario.nombre, anuladaEn: serverTimestamp()
        });
        await pintarDetalleFactura(cont, id);
        mostrar("Anulado.", "ok");
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
  sf.forEach((d) => { const f = d.data(); if (cuentaComoGasto(f)) gasto[f.proveedorId] = (gasto[f.proveedorId] || 0) + f.total; });
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
      <label for="pNotas">Notas</label><textarea id="pNotas" placeholder="Comercial, pedido mínimo, manda albarán y factura aparte…">${esc(p.notas)}</textarea>
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
