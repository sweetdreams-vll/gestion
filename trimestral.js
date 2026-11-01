// =============================================================
// MÓDULO CIERRE TRIMESTRAL (versión 2): resumen para la gestoría.
// Ventas (cierres de caja + otros ingresos), IVA soportado (facturas + alquiler),
// retenciones del alquiler (modelo 115), estimación del 303 y exportación.
// «Ventas previas»: totales de días anteriores a usar la app (caja 1 y caja 2),
// que cuentan en el trimestre pero no tocan la caja roja.
// La gestoría es quien valida y presenta los modelos.
// =============================================================
import {
  db, estado, $, esc, eur, leerEur, centimosATexto, mostrar, traducirError, iso, ms, vigentes
} from "./nucleo.js?v=2";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const IVA_VENTAS = 10;        // consumo en el bar
const IVA_DIANAS = 21;        // máquinas recreativas
const IVA_ALQUILER = 21;
const RETENCION_ALQUILER = 19;
const ALQUILER_POR_DEFECTO = 150000; // 1.500 € al mes (desde octubre de 2026)

export const moduloTrimestral = {
  id: "trimestral",
  titulo: "Cierre trimestral",
  descripcion: "Resumen de IVA y alquiler para la gestoría, con exportación",
  icono: "",
  enBarra: false,
  roles: ["socio"],
  pestanas: [
    { id: "resumen", titulo: "Resumen" },
    { id: "ingresos", titulo: "Ingresos" },
    { id: "alquiler", titulo: "Alquiler" },
    { id: "previas", titulo: "Ventas previas" },
    { id: "imprimir", oculta: true, padre: "resumen" }
  ],
  render: ({ sub, resto, cont }) => {
    if (sub === "ingresos") return pintarIngresos(cont);
    if (sub === "alquiler") return pintarAlquiler(cont);
    if (sub === "previas") return pintarPrevias(cont);
    if (sub === "imprimir") return pintarImprimible(cont, resto[0]);
    return pintarResumen(cont, resto[0]);
  }
};

// ---------- Estilos (también para imprimir el PDF) ----------
(function () {
  if (document.getElementById("css-trimestral")) return;
  const s = document.createElement("style");
  s.id = "css-trimestral";
  s.textContent = `
    .trim-nav { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    .trim-nav a { text-decoration:none; color:var(--texto); background:var(--panel2); border:1px solid var(--borde); border-radius:10px; padding:8px 14px; }
    .casilla { display:inline-block; min-width:26px; text-align:center; font-size:.72rem; border:1px solid var(--borde); border-radius:6px; padding:0 4px; margin-right:6px; color:var(--suave); }
    .aviso-lista li { margin:6px 0; line-height:1.4; }
    .badge { display:inline-block; font-size:.75rem; padding:2px 8px; border-radius:20px; margin-left:6px; font-weight:400; }
    .badge.anulada { background:var(--rojoF); }
    @media print {
      :root { --fondo:#fff; --panel:#fff; --panel2:#f2f2f2; --texto:#000; --suave:#444; --borde:#bbb; }
      body { background:#fff; color:#000; padding:0; }
      .barra, #pestanas, header, .pie, .no-imprimir, #mensaje { display:none !important; }
      .panel { break-inside:avoid; border-color:#bbb; }
    }
  `;
  document.head.appendChild(s);
})();

// ---------- Trimestres ----------
function trimestreDe(fecha) {
  const [y, m] = fecha.split("-").map(Number);
  return `${y}-${Math.floor((m - 1) / 3) + 1}`;
}
function limites(clave) {
  const [y, t] = clave.split("-").map(Number);
  const mesIni = (t - 1) * 3 + 1;
  const desde = `${y}-${String(mesIni).padStart(2, "0")}-01`;
  const hasta = iso(new Date(y, mesIni + 2, 0)); // último día del trimestre
  return { y, t, desde, hasta, meses: [0, 1, 2].map((i) => `${y}-${String(mesIni + i).padStart(2, "0")}`) };
}
function claveVecina(clave, paso) {
  let [y, t] = clave.split("-").map(Number);
  t += paso;
  if (t < 1) { t = 4; y--; }
  if (t > 4) { t = 1; y++; }
  return `${y}-${t}`;
}
const nombreTrim = (clave) => { const [y, t] = clave.split("-"); return `${t}.º trimestre de ${y}`; };
const fechaCorta = (t) => (t ? t.split("-").reverse().join("/") : "");
const nombreMes = (m) => { const s = new Date(m + "-01T12:00:00").toLocaleDateString("es-ES", { month: "long", year: "numeric" }); return s.charAt(0).toUpperCase() + s.slice(1); };
// De un total con IVA saca la base, redondeando a céntimos
const baseDe = (total, tipo) => Math.round(total / (1 + tipo / 100));

// ---------- Datos del trimestre ----------
async function cargarTrimestre(clave) {
  const L = limites(clave);
  const [sc, sk, sf, si, sa, sajustes, sv] = await Promise.all([
    getDocs(query(collection(db, "cierres"), where("fecha", ">=", L.desde), where("fecha", "<=", L.hasta))),
    getDocs(collection(db, "correcciones")),
    getDocs(query(collection(db, "facturas"), where("fecha", ">=", L.desde), where("fecha", "<=", L.hasta))),
    getDocs(collection(db, "ingresos")),
    getDocs(collection(db, "alquileres")),
    getDoc(doc(db, "ajustes", "trimestral")),
    getDocs(collection(db, "ventasPrevias"))
  ]);
  const corr = {};
  sk.forEach((d) => { const c = d.data(); (corr[c.cierreId] ||= []).push(c); });
  Object.values(corr).forEach((l) => l.sort((a, b) => ms(a.creadoEn) - ms(b.creadoEn)));

  const cierres = [];
  sc.forEach((d) => { const c = d.data(); cierres.push({ id: d.id, ...c, v: vigentes(c, corr[d.id]) }); });
  cierres.sort((a, b) => a.fecha.localeCompare(b.fecha));

  const facturas = [];
  sf.forEach((d) => facturas.push({ id: d.id, ...d.data() }));
  facturas.sort((a, b) => a.fecha.localeCompare(b.fecha));
  // Si una factura no trae CIF, se usa el del proveedor
  try {
    const sp = await getDocs(collection(db, "proveedores"));
    const cifProv = {};
    sp.forEach((x) => { cifProv[x.id] = x.data().cif || ""; });
    facturas.forEach((f) => { if (!f.cif) f.cif = cifProv[f.proveedorId] || ""; });
  } catch (e) { /* sin proveedores */ }

  const ingresos = [];
  si.forEach((d) => { const x = { id: d.id, ...d.data() }; if (x.fecha >= L.desde && x.fecha <= L.hasta) ingresos.push(x); });
  ingresos.sort((a, b) => a.fecha.localeCompare(b.fecha));

  const alquileres = [];
  sa.forEach((d) => { const x = { id: d.id, ...d.data() }; if (L.meses.includes(x.mes)) alquileres.push(x); });
  alquileres.sort((a, b) => a.mes.localeCompare(b.mes));

  const compensar = (sajustes.exists() && sajustes.data().compensar && sajustes.data().compensar[clave]) || 0;
  const previas = [];
  sv.forEach((x) => { const v = { id: x.id, ...x.data() }; if (!v.anulado && v.desde >= L.desde && v.desde <= L.hasta) previas.push(v); });
  previas.sort((a, b) => a.desde.localeCompare(b.desde));
  return { L, cierres, facturas, ingresos, alquileres, compensar, previas };
}

function calcular(d) {
  // Ventas en barra (cierres): total con IVA al 10 %
  // más las ventas previas de la caja 1 cargadas a mano (días antes de usar la app)
  const previas1 = d.previas.filter((v) => v.caja === 1);
  const previasEfectivo = previas1.reduce((s, v) => s + v.efectivo, 0);
  const previasTarjeta = previas1.reduce((s, v) => s + v.tarjeta, 0);
  const ventasEfectivo = d.cierres.reduce((s, c) => s + c.v.ticketEfectivo, 0) + previasEfectivo;
  const ventasTarjeta = d.cierres.reduce((s, c) => s + c.v.ticketTarjeta, 0) + previasTarjeta;
  const ventasTotal = ventasEfectivo + ventasTarjeta;
  const ventasBase = baseDe(ventasTotal, IVA_VENTAS);
  const ventasCuota = ventasTotal - ventasBase;

  // Otros ingresos (dianas) al 21 %
  const ingresosOk = d.ingresos.filter((x) => !x.anulado);
  const ingBase = ingresosOk.reduce((s, x) => s + x.base, 0);
  const ingCuota = ingresosOk.reduce((s, x) => s + x.cuota, 0);

  // IVA soportado: solo facturas (no albaranes) no anuladas, por tipo, más el alquiler
  const porTipo = {};
  const sumar = (tipo, base, cuota) => { const x = (porTipo[tipo] ||= { base: 0, cuota: 0 }); x.base += base; x.cuota += cuota; };
  const fiscales = d.facturas.filter((f) => !f.anulada && f.tipo !== "albaran");
  fiscales.forEach((f) => (f.bases || []).forEach((b) => sumar(b.tipoIva, b.base, b.cuota)));
  const alqOk = d.alquileres.filter((x) => !x.anulado);
  alqOk.forEach((a) => sumar(IVA_ALQUILER, a.base, a.cuota));
  const soportadoBase = Object.values(porTipo).reduce((s, x) => s + x.base, 0);
  const soportadoCuota = Object.values(porTipo).reduce((s, x) => s + x.cuota, 0);

  const devengado = ventasCuota + ingCuota;
  const resultado = devengado - soportadoCuota;

  // 115: alquiler
  const alqBase = alqOk.reduce((s, a) => s + a.base, 0);
  const alqRet = alqOk.reduce((s, a) => s + a.retencion, 0);

  // Avisos
  const avisos = [];
  const fechasCierre = new Set(d.cierres.map((c) => c.fecha));
  previas1.forEach((v) => { for (let f = new Date(v.desde + "T12:00:00"); iso(f) <= v.hasta; f.setDate(f.getDate() + 1)) fechasCierre.add(iso(f)); });
  const hoy = iso(new Date());
  const faltan = [];
  for (let f = new Date(d.L.desde + "T12:00:00"); iso(f) <= d.L.hasta && iso(f) < hoy; f.setDate(f.getDate() + 1)) {
    if (!fechasCierre.has(iso(f))) faltan.push(iso(f));
  }
  if (faltan.length) avisos.push(`${faltan.length} día${faltan.length > 1 ? "s" : ""} sin cierre de caja${faltan.length <= 6 ? ": " + faltan.map(fechaCorta).join(", ") : ""}. Si el bar abrió, falta registrarlos; si estuvo cerrado, no pasa nada.`);
  const albSinFactura = d.facturas.filter((f) => !f.anulada && f.tipo === "albaran" && !f.facturaId);
  if (albSinFactura.length) avisos.push(`${albSinFactura.length} albarán${albSinFactura.length > 1 ? "es" : ""} sin su factura (${eur(albSinFactura.reduce((s, f) => s + f.total, 0))}). Su IVA no se puede deducir hasta que llegue la factura.`);
  const sinCif = fiscales.filter((f) => !f.cif);
  if (sinCif.length) avisos.push(`${sinCif.length} factura${sinCif.length > 1 ? "s" : ""} sin CIF del proveedor. La gestoría lo necesita para deducir el IVA.`);
  const mesesSinAlq = d.L.meses.filter((m) => m < hoy.slice(0, 7) && !alqOk.some((a) => a.mes === m));
  if (mesesSinAlq.length) avisos.push(`Falta registrar el alquiler de ${mesesSinAlq.map(nombreMes).join(", ")}.`);

  return { ventasTotal, ventasEfectivo, ventasTarjeta, ventasBase, ventasCuota, ingBase, ingCuota, porTipo, soportadoBase, soportadoCuota, devengado, resultado, alqBase, alqRet, avisos, fiscales, alqOk, ingresosOk, diasCierre: d.cierres.length, previas1, previasTotal: previasEfectivo + previasTarjeta };
}

// ---------- Resumen ----------
async function pintarResumen(cont, claveParam) {
  const clave = /^\d{4}-[1-4]$/.test(claveParam || "") ? claveParam : trimestreDe(iso(new Date()));
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const d = await cargarTrimestre(clave);
  const r = calcular(d);
  const final = r.resultado - d.compensar;
  const tipos = Object.keys(r.porTipo).map(Number).sort((a, b) => a - b);

  cont.innerHTML = `
    <div class="panel no-imprimir">
      <div class="trim-nav">
        <a href="#/trimestral/resumen/${claveVecina(clave, -1)}" aria-label="Trimestre anterior">‹</a>
        <strong>${esc(nombreTrim(clave))}</strong>
        <a href="#/trimestral/resumen/${claveVecina(clave, 1)}" aria-label="Trimestre siguiente">›</a>
      </div>
      <small class="nota">Del ${fechaCorta(d.L.desde)} al ${fechaCorta(d.L.hasta)}. Es una estimación para preparar el trimestre: la gestoría lo revisa y presenta los modelos.</small>
    </div>

    ${r.avisos.length ? `<div class="panel"><h2>Antes de mandarlo, revisa</h2><ul class="aviso-lista" style="margin:0;padding-left:18px">${r.avisos.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>` : `<div class="panel"><div class="estado ok" style="margin-top:0">Todo registrado: no falta nada en este trimestre</div></div>`}

    <div class="panel">
      <h2>Ventas en barra (cierres de caja)</h2>
      <div class="resumen">
        <div><span>Días con cierre</span><strong>${r.diasCierre}</strong></div>
        ${r.previas1.length ? `<div><span>Ventas previas cargadas a mano (${r.previas1.length})</span><strong>${eur(r.previasTotal)}</strong></div>` : ""}
        <div><span>Efectivo</span><strong>${eur(r.ventasEfectivo)}</strong></div>
        <div><span>Tarjeta</span><strong>${eur(r.ventasTarjeta)}</strong></div>
        <div><span>Total vendido (IVA incluido)</span><strong>${eur(r.ventasTotal)}</strong></div>
        <div><span><span class="casilla">04</span>Base al ${IVA_VENTAS} %</span><strong>${eur(r.ventasBase)}</strong></div>
        <div><span><span class="casilla">06</span>IVA al ${IVA_VENTAS} %</span><strong>${eur(r.ventasCuota)}</strong></div>
      </div>
    </div>

    <div class="panel">
      <h2>Otros ingresos (dianas)</h2>
      <div class="resumen">
        <div><span><span class="casilla">07</span>Base al ${IVA_DIANAS} %</span><strong>${eur(r.ingBase)}</strong></div>
        <div><span><span class="casilla">09</span>IVA al ${IVA_DIANAS} %</span><strong>${eur(r.ingCuota)}</strong></div>
      </div>
      <a class="boton sec no-imprimir" href="#/trimestral/ingresos">Ver o apuntar ingresos</a>
    </div>

    <div class="panel">
      <h2>IVA de las compras (facturas y alquiler)</h2>
      <div class="resumen">
        ${tipos.map((t) => `<div><span>Base al ${t} % / IVA</span><strong>${eur(r.porTipo[t].base)} / ${eur(r.porTipo[t].cuota)}</strong></div>`).join("")}
        <div><span><span class="casilla">28</span>Base total</span><strong>${eur(r.soportadoBase)}</strong></div>
        <div><span><span class="casilla">29</span>IVA deducible</span><strong>${eur(r.soportadoCuota)}</strong></div>
      </div>
      <small class="nota">${r.fiscales.length} facturas y ${r.alqOk.length} mes${r.alqOk.length === 1 ? "" : "es"} de alquiler. Los albaranes sin factura no cuentan.</small>
    </div>

    <div class="panel">
      <h2>Estimación del modelo 303</h2>
      <div class="resumen">
        <div><span><span class="casilla">27</span>IVA de las ventas</span><strong>${eur(r.devengado)}</strong></div>
        <div><span><span class="casilla">45</span>IVA a deducir</span><strong>${eur(r.soportadoCuota)}</strong></div>
        <div><span><span class="casilla">46</span>Resultado del trimestre</span><strong class="${r.resultado > 0 ? "neg" : "cero"}">${eur(r.resultado)}</strong></div>
        <div><span><span class="casilla">110</span>A compensar de trimestres anteriores</span><strong>${eur(d.compensar)}</strong></div>
        <div><span>Resultado final aproximado</span><strong class="${final > 0 ? "neg" : "cero"}">${final > 0 ? "A pagar " + eur(final) : "A compensar " + eur(-final)}</strong></div>
      </div>
      <div class="no-imprimir">
        <label for="tCompensar">IVA a compensar de trimestres anteriores (lo pone el 303 anterior)</label>
        <div class="fila"><input id="tCompensar" inputmode="decimal" value="${d.compensar ? centimosATexto(d.compensar) : ""}" placeholder="0,00"><button class="sec" id="tGuardarCompensar" type="button" style="margin-top:0">Guardar</button></div>
        ${clave.endsWith("-4") ? `<small class="nota">En el 4.º trimestre, si sale a compensar, se puede pedir a Hacienda que <strong>devuelva</strong> el dinero en lugar de seguir compensándolo. Coméntalo con la gestoría.</small>` : ""}
      </div>
    </div>

    <div class="panel">
      <h2>Alquiler y retención (modelo 115)</h2>
      <div class="resumen">
        <div><span>Base del alquiler del trimestre</span><strong>${eur(r.alqBase)}</strong></div>
        <div><span>Retención del ${RETENCION_ALQUILER} % a ingresar</span><strong>${eur(r.alqRet)}</strong></div>
      </div>
      <a class="boton sec no-imprimir" href="#/trimestral/alquiler">Ver o apuntar alquiler</a>
    </div>

    <div id="tCaja2"></div>

    <div class="panel no-imprimir">
      <h2>Mandar a la gestoría</h2>
      <button id="tCompartir" type="button">Compartir los archivos (Excel)</button>
      <button class="sec" id="tPdf" type="button">Ver el resumen para guardar en PDF</button>
      <small class="nota">Los archivos se abren con Excel: facturas recibidas, ventas día a día, otros ingresos y alquiler. Para el PDF, en la pantalla de imprimir elige «Guardar como PDF».</small>
    </div>`;

  $("tGuardarCompensar").addEventListener("click", async () => {
    const v = $("tCompensar").value.trim() === "" ? 0 : leerEur($("tCompensar").value);
    if (isNaN(v)) return mostrar("Escribe un importe válido.", "mal");
    try {
      await setDoc(doc(db, "ajustes", "trimestral"), { compensar: { [clave]: v }, actualizadoPor: estado.usuario.nombre, actualizadoEn: serverTimestamp() }, { merge: true });
      await pintarResumen(cont, clave);
      mostrar("Guardado.", "ok");
    } catch (e) { mostrar("No se ha podido guardar: " + traducirError(e.code || e.message), "mal"); }
  });
  $("tPdf").addEventListener("click", () => { location.hash = `#/trimestral/imprimir/${clave}`; });
  $("tCompartir").addEventListener("click", () => compartirArchivos(clave, d, r));
  pintarCaja2Trimestre(d.L);
}

// ---------- Exportación (CSV para Excel) ----------
const num2 = (c) => (c / 100).toFixed(2).replace(".", ",");
function csv(filas) {
  const celda = (v) => {
    const s = String(v ?? "");
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "\ufeff" + filas.map((f) => f.map(celda).join(";")).join("\r\n");
}

async function compartirArchivos(clave, d, r) {
  const sufijo = clave.replace("-", "_T");
  const facturas = [["Fecha", "Número", "Proveedor", "CIF", "Tipo", "Base 4%", "IVA 4%", "Base 10%", "IVA 10%", "Base 21%", "IVA 21%", "Otras bases", "Otras cuotas", "Total", "Pago", "Estado"]];
  r.fiscales.forEach((f) => {
    const b = {}; let ob = 0, oc = 0;
    (f.bases || []).forEach((x) => { if ([4, 10, 21].includes(x.tipoIva)) b[x.tipoIva] = x; else { ob += x.base; oc += x.cuota; } });
    const v = (t, k) => (b[t] ? num2(b[t][k]) : "");
    facturas.push([fechaCorta(f.fecha), f.numero, f.proveedorNombre, f.cif || "", "Factura", v(4, "base"), v(4, "cuota"), v(10, "base"), v(10, "cuota"), v(21, "base"), v(21, "cuota"), ob ? num2(ob) : "", oc ? num2(oc) : "", num2(f.total), f.pagadaDesde || "", f.estado || ""]);
  });
  r.alqOk.forEach((a) => facturas.push([fechaCorta(a.fechaFactura || a.mes + "-01"), a.numero || "", a.arrendador || "Alquiler del local", a.cif || "", "Alquiler", "", "", "", "", num2(a.base), num2(a.cuota), "", "", num2(a.base + a.cuota - a.retencion), "", "Retención " + num2(a.retencion)]));

  const ventas = [["Fecha", "Efectivo", "Tarjeta", "Total (IVA incl.)", "Base 10%", "IVA 10%", "Gastos pagados de caja", "Hecho por"]];
  d.cierres.forEach((c) => { const base = baseDe(c.v.ticketTotal, IVA_VENTAS); ventas.push([fechaCorta(c.fecha), num2(c.v.ticketEfectivo), num2(c.v.ticketTarjeta), num2(c.v.ticketTotal), num2(base), num2(c.v.ticketTotal - base), num2(c.v.totalGastos), c.autorNombre || ""]); });
  r.previas1.forEach((v) => { const t = v.efectivo + v.tarjeta, base = baseDe(t, IVA_VENTAS); ventas.push([`${fechaCorta(v.desde)}${v.hasta !== v.desde ? " a " + fechaCorta(v.hasta) : ""} (cargado a mano)`, num2(v.efectivo), num2(v.tarjeta), num2(t), num2(base), num2(t - base), num2(v.gastos || 0), v.autorNombre || ""]); });
  ventas.push(["TOTAL", num2(r.ventasEfectivo), num2(r.ventasTarjeta), num2(r.ventasTotal), num2(r.ventasBase), num2(r.ventasCuota), "", ""]);

  const ingresos = [["Fecha", "Concepto", "Base", "IVA %", "IVA", "Total"]];
  r.ingresosOk.forEach((x) => ingresos.push([fechaCorta(x.fecha), x.concepto, num2(x.base), x.tipoIva, num2(x.cuota), num2(x.base + x.cuota)]));

  const archivos = [
    new File([csv(facturas)], `facturas_recibidas_${sufijo}.csv`, { type: "text/csv" }),
    new File([csv(ventas)], `ventas_cierres_${sufijo}.csv`, { type: "text/csv" }),
    new File([csv(ingresos)], `otros_ingresos_${sufijo}.csv`, { type: "text/csv" })
  ];
  const texto = `Sweet Dreams, ${nombreTrim(clave)}: facturas recibidas, ventas por día (cierres de caja) y otros ingresos.`;
  try {
    if (navigator.canShare && navigator.canShare({ files: archivos })) {
      await navigator.share({ files: archivos, title: "Sweet Dreams " + nombreTrim(clave), text: texto });
      return;
    }
  } catch (e) { if (e.name === "AbortError") return; }
  // Si el móvil no deja compartir archivos, se descargan uno a uno
  archivos.forEach((f, i) => setTimeout(() => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, i * 600));
  mostrar("Archivos descargados en la carpeta de Descargas.", "ok");
}

// ---------- Versión para imprimir o guardar en PDF ----------
async function pintarImprimible(cont, clave) {
  if (!/^\d{4}-[1-4]$/.test(clave || "")) { location.hash = "#/trimestral/resumen"; return; }
  await pintarResumen(cont, clave);
  const volver = document.createElement("div");
  volver.className = "panel no-imprimir";
  volver.innerHTML = `<button id="tImprimir" type="button" style="margin-top:0">Imprimir o guardar en PDF</button><a class="boton sec" href="#/trimestral/resumen/${clave}">Volver</a>`;
  cont.prepend(volver);
  $("tImprimir").addEventListener("click", () => window.print());
  setTimeout(() => window.print(), 400);
}

// =============================================================
// OTROS INGRESOS (dianas y similares)
// =============================================================
async function pintarIngresos(cont) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const s = await getDocs(collection(db, "ingresos"));
  const lista = [];
  s.forEach((d) => lista.push({ id: d.id, ...d.data() }));
  lista.sort((a, b) => b.fecha.localeCompare(a.fecha));

  cont.innerHTML = `
    <div class="panel">
      <h2>Apuntar ingreso</h2>
      <label for="iFecha">Fecha</label><input id="iFecha" type="date" value="${iso(new Date())}">
      <label for="iConcepto">Concepto</label><input id="iConcepto" value="Dianas (máquinas recreativas)">
      <div class="fila">
        <div><label for="iTotal">Total cobrado, IVA incluido (€)</label><input id="iTotal" inputmode="decimal" placeholder="0,00"></div>
        <div><label for="iIva">IVA %</label><select id="iIva"><option>21</option><option>10</option><option>0</option></select></div>
      </div>
      <small class="nota" id="iDesglose"></small>
      <label for="iObs">Observaciones (opcional)</label><input id="iObs" placeholder="Liquidación de octubre">
      <button id="iGuardar" type="button">Guardar ingreso</button>
    </div>
    <div class="semana"><h3>Registrados</h3>
      ${lista.length ? lista.map((x) => `
        <div class="item">
          <div class="top"><span>${esc(x.concepto)}${x.anulado ? '<span class="badge anulada">anulado</span>' : ""}</span><span>${eur(x.base + x.cuota)}</span></div>
          <div class="sub"><span>${esc(fechaCorta(x.fecha))}, base ${eur(x.base)} + IVA ${eur(x.cuota)}</span>
            ${x.anulado ? "" : `<button class="sec iAnular" data-id="${esc(x.id)}" type="button" style="width:auto;margin:0;padding:4px 10px;font-size:.8rem">Anular</button>`}</div>
        </div>`).join("") : '<p class="suave">Todavía no hay ingresos apuntados.</p>'}
    </div>`;

  const desglose = () => {
    const t = leerEur($("iTotal").value), tipo = Number($("iIva").value);
    $("iDesglose").textContent = t && !isNaN(t) ? `Base ${eur(baseDe(t, tipo))} + IVA ${eur(t - baseDe(t, tipo))}` : "";
  };
  $("iTotal").addEventListener("input", desglose);
  $("iIva").addEventListener("change", desglose);

  $("iGuardar").addEventListener("click", async () => {
    const total = leerEur($("iTotal").value), tipo = Number($("iIva").value);
    const fecha = $("iFecha").value, concepto = $("iConcepto").value.trim();
    if (!fecha || !concepto) return mostrar("Falta la fecha o el concepto.", "mal");
    if (!total || isNaN(total) || total <= 0) return mostrar("Escribe el total cobrado.", "mal");
    const base = baseDe(total, tipo);
    if (!confirm(`¿Guardar ${concepto} del ${fechaCorta(fecha)} por ${eur(total)}?`)) return;
    try {
      await setDoc(doc(collection(db, "ingresos")), {
        fecha, concepto, tipoIva: tipo, base, cuota: total - base, total,
        observaciones: $("iObs").value.trim(), anulado: false,
        autorUid: estado.usuario.uid, autorNombre: estado.usuario.nombre, creadoEn: serverTimestamp()
      });
      await pintarIngresos(cont);
      mostrar("Ingreso guardado.", "ok");
    } catch (e) { mostrar("No se ha podido guardar: " + traducirError(e.code || e.message), "mal"); }
  });
  activarAnular(cont, "ingresos", () => pintarIngresos(cont));
}

// =============================================================
// ALQUILER (una factura al mes, con IVA y retención)
// =============================================================
async function pintarAlquiler(cont) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const s = await getDocs(collection(db, "alquileres"));
  const lista = [];
  s.forEach((d) => lista.push({ id: d.id, ...d.data() }));
  lista.sort((a, b) => b.mes.localeCompare(a.mes));
  const ultimo = lista.find((x) => !x.anulado);
  const baseDefecto = ultimo ? ultimo.base : ALQUILER_POR_DEFECTO;
  const mesActual = iso(new Date()).slice(0, 7);

  cont.innerHTML = `
    <div class="panel">
      <h2>Apuntar alquiler de un mes</h2>
      <label for="aMes">Mes</label><input id="aMes" type="month" value="${mesActual}">
      <label for="aBase">Base del alquiler (€, sin IVA)</label><input id="aBase" inputmode="decimal" value="${centimosATexto(baseDefecto)}">
      <div class="resumen" id="aCalculo" style="margin-top:10px"></div>
      <div class="fila">
        <div><label for="aNumero">Nº de factura (opcional)</label><input id="aNumero"></div>
        <div><label for="aFecha">Fecha de la factura</label><input id="aFecha" type="date" value="${iso(new Date())}"></div>
      </div>
      <label for="aArrendador">Casero (opcional)</label><input id="aArrendador" value="${esc(ultimo ? ultimo.arrendador || "" : "")}" placeholder="Nombre del propietario">
      <label for="aCif">NIF del casero (opcional)</label><input id="aCif" value="${esc(ultimo ? ultimo.cif || "" : "")}" autocapitalize="characters">
      <button id="aGuardar" type="button">Guardar alquiler</button>
    </div>
    <div class="semana"><h3>Registrados</h3>
      ${lista.length ? lista.map((x) => `
        <div class="item">
          <div class="top"><span>${esc(nombreMes(x.mes))}${x.anulado ? '<span class="badge anulada">anulado</span>' : ""}</span><span>${eur(x.base + x.cuota - x.retencion)}</span></div>
          <div class="sub"><span>Base ${eur(x.base)} + IVA ${eur(x.cuota)} − retención ${eur(x.retencion)}</span>
            ${x.anulado ? "" : `<button class="sec iAnular" data-id="${esc(x.id)}" type="button" style="width:auto;margin:0;padding:4px 10px;font-size:.8rem">Anular</button>`}</div>
        </div>`).join("") : '<p class="suave">Todavía no hay alquileres apuntados.</p>'}
    </div>`;

  const calc = () => {
    const base = leerEur($("aBase").value);
    if (!base || isNaN(base)) { $("aCalculo").innerHTML = ""; return null; }
    const cuota = Math.round(base * IVA_ALQUILER / 100), retencion = Math.round(base * RETENCION_ALQUILER / 100);
    $("aCalculo").innerHTML = `
      <div><span>IVA ${IVA_ALQUILER} %</span><strong>${eur(cuota)}</strong></div>
      <div><span>Retención ${RETENCION_ALQUILER} % (la ingresáis vosotros en el 115)</span><strong>−${eur(retencion)}</strong></div>
      <div><span>A pagar al casero</span><strong>${eur(base + cuota - retencion)}</strong></div>`;
    return { base, cuota, retencion };
  };
  $("aBase").addEventListener("input", calc);
  calc();

  $("aGuardar").addEventListener("click", async () => {
    const c = calc();
    const mes = $("aMes").value;
    if (!mes || !c) return mostrar("Falta el mes o la base.", "mal");
    if (lista.some((x) => x.mes === mes && !x.anulado)) return mostrar("Ese mes ya está apuntado. Si está mal, anúlalo y vuelve a apuntarlo.", "mal");
    if (!confirm(`¿Guardar el alquiler de ${nombreMes(mes)}: base ${eur(c.base)}?`)) return;
    try {
      await setDoc(doc(collection(db, "alquileres")), {
        mes, base: c.base, tipoIva: IVA_ALQUILER, cuota: c.cuota, tipoRetencion: RETENCION_ALQUILER, retencion: c.retencion,
        numero: $("aNumero").value.trim(), fechaFactura: $("aFecha").value,
        arrendador: $("aArrendador").value.trim(), cif: $("aCif").value.trim().toUpperCase(),
        anulado: false, autorUid: estado.usuario.uid, autorNombre: estado.usuario.nombre, creadoEn: serverTimestamp()
      });
      await pintarAlquiler(cont);
      mostrar("Alquiler guardado.", "ok");
    } catch (e) { mostrar("No se ha podido guardar: " + traducirError(e.code || e.message), "mal"); }
  });
  activarAnular(cont, "alquileres", () => pintarAlquiler(cont));
}

// Anular un ingreso o un alquiler (no se borra: queda marcado con el motivo)
function activarAnular(cont, coleccion, repintar) {
  cont.querySelectorAll(".iAnular").forEach((b) => b.addEventListener("click", async () => {
    const motivo = prompt("¿Por qué se anula?");
    if (!motivo || !motivo.trim()) return;
    try {
      await updateDoc(doc(db, coleccion, b.dataset.id), {
        anulado: true, motivoAnulacion: motivo.trim(), anuladoPor: estado.usuario.nombre, anuladoEn: serverTimestamp()
      });
      await repintar();
      mostrar("Anulado.", "ok");
    } catch (e) { mostrar("No se ha podido anular: " + traducirError(e.code || e.message), "mal"); }
  }));
}

// ---------- Caja 2: se ve en el resumen, pero no suma en el 303 de Sweet Dreams ----------
async function pintarCaja2Trimestre(L) {
  const caja = document.getElementById("tCaja2");
  if (!caja) return;
  try {
    const [s, sa, sv] = await Promise.all([
      getDocs(query(collection(db, "cierresCaja2"), where("fecha", ">=", L.desde), where("fecha", "<=", L.hasta))),
      getDoc(doc(db, "ajustes", "caja2")),
      getDocs(collection(db, "ventasPrevias"))
    ]);
    let venta = 0, retirado = 0, n = 0, previas = 0;
    s.forEach((d) => { const c = d.data(); if (c.anulado) return; venta += c.venta; retirado += c.aRetirar; n++; });
    sv.forEach((d) => { const v = d.data(); if (!v.anulado && v.caja === 2 && v.desde >= L.desde && v.desde <= L.hasta) previas += v.efectivo; });
    venta += previas;
    if (!n && !previas) return;
    const quien = sa.exists() && sa.data().declaradaPor;
    caja.innerHTML = `
      <div class="panel">
        <h2>Caja 2 (se declara aparte)</h2>
        <div class="resumen">
          <div><span>Días con cierre</span><strong>${n}</strong></div>
          ${previas ? `<div><span>Ventas previas cargadas a mano</span><strong>${eur(previas)}</strong></div>` : ""}
          <div><span>Ventas de la caja 2</span><strong>${eur(venta)}</strong></div>
          <div><span>Llevado a la caja roja</span><strong>${eur(retirado)}</strong></div>
          <div><span>Se declara en</span><strong>${esc(quien || "Sin indicar")}</strong></div>
        </div>
        ${quien ? "" : '<div class="estado mal" style="font-weight:400">Falta indicar dónde se declara (Caja 2 → Historial).</div>'}
        <small class="nota">No suma en la estimación del 303 de Sweet Dreams porque se declara por otro lado.</small>
      </div>`;
  } catch (e) { /* sin datos */ }
}

// =============================================================
// VENTAS PREVIAS: días anteriores a usar la app (caja 1 y caja 2)
// Cuentan en el trimestre, pero no en la caja roja (ese dinero ya se contó o se gastó).
// =============================================================
async function pintarPrevias(cont) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const s = await getDocs(collection(db, "ventasPrevias"));
  const lista = [];
  s.forEach((d) => lista.push({ id: d.id, ...d.data() }));
  lista.sort((a, b) => b.desde.localeCompare(a.desde) || a.caja - b.caja);

  cont.innerHTML = `
    <div class="panel">
      <h2>Cargar ventas de días anteriores</h2>
      <p class="suave" style="margin-top:0;line-height:1.5">Para los días antes de empezar a usar la app. Puedes cargar un día con su ticket o el total de varios días seguidos. Cuenta en el trimestre, pero no en la caja roja.</p>
      <label for="pCaja">Caja</label>
      <select id="pCaja"><option value="1">Caja 1 (registradora con ticket)</option><option value="2">Caja 2 (se declara aparte)</option></select>
      <div class="fila">
        <div><label for="pDesde">Desde</label><input id="pDesde" type="date"></div>
        <div><label for="pHasta">Hasta (incluido)</label><input id="pHasta" type="date"></div>
      </div>
      <div class="fila">
        <div><label for="pEfectivo" id="pEtiEfectivo">Efectivo (€)</label><input id="pEfectivo" inputmode="decimal" placeholder="0,00"></div>
        <div id="pCajaTarjeta"><label for="pTarjeta">Tarjeta (€)</label><input id="pTarjeta" inputmode="decimal" placeholder="0,00"></div>
      </div>
      <label for="pGastos">Gastos pagados con la caja (€, opcional)</label><input id="pGastos" inputmode="decimal" placeholder="0,00">
      <label for="pNota">Nota (opcional)</label><input id="pNota" placeholder="Tickets Z de la semana del 6 al 12">
      <small class="nota" id="pTotal"></small>
      <button id="pGuardar" type="button">Guardar</button>
    </div>
    <div class="semana"><h3>Cargadas</h3>
      ${lista.length ? lista.map((v) => `
        <div class="item" style="${v.anulado ? "opacity:.5" : ""}">
          <div class="top"><span>Caja ${v.caja} · ${esc(fechaCorta(v.desde))}${v.hasta !== v.desde ? " a " + esc(fechaCorta(v.hasta)) : ""}${v.anulado ? '<span class="badge anulada">anulado</span>' : ""}</span><span>${eur(v.efectivo + (v.tarjeta || 0))}</span></div>
          <div class="sub"><span>${v.caja === 1 ? `Efectivo ${eur(v.efectivo)} · tarjeta ${eur(v.tarjeta || 0)}` : "Venta " + eur(v.efectivo)}${v.gastos ? " · gastos " + eur(v.gastos) : ""}${v.nota ? " · " + esc(v.nota) : ""}</span>
            ${v.anulado ? "" : `<button class="sec iAnular" data-id="${esc(v.id)}" type="button" style="width:auto;margin:0;padding:4px 10px;font-size:.8rem">Anular</button>`}</div>
        </div>`).join("") : '<p class="suave">Todavía no hay ventas previas cargadas.</p>'}
    </div>`;

  const actualizar = () => {
    const caja2 = $("pCaja").value === "2";
    $("pCajaTarjeta").classList.toggle("oculto", caja2);
    $("pEtiEfectivo").textContent = caja2 ? "Venta (€)" : "Efectivo (€)";
    if (!$("pHasta").value && $("pDesde").value) $("pHasta").value = $("pDesde").value;
    const ef = leerEur($("pEfectivo").value) || 0, tj = caja2 ? 0 : (leerEur($("pTarjeta").value) || 0);
    $("pTotal").textContent = ef + tj ? "Total vendido: " + eur(ef + tj) : "";
  };
  cont.querySelector(".panel").addEventListener("input", actualizar);
  cont.querySelector(".panel").addEventListener("change", actualizar);

  $("pGuardar").addEventListener("click", async () => {
    const caja = Number($("pCaja").value);
    const desde = $("pDesde").value, hasta = $("pHasta").value || desde;
    const efectivo = leerEur($("pEfectivo").value) || 0;
    const tarjeta = caja === 1 ? (leerEur($("pTarjeta").value) || 0) : 0;
    const gastos = leerEur($("pGastos").value) || 0;
    if (!desde) return mostrar("Falta la fecha.", "mal");
    if (hasta < desde) return mostrar("La fecha «hasta» no puede ser anterior a «desde».", "mal");
    if (trimestreDe(desde) !== trimestreDe(hasta)) return mostrar("Carga cada trimestre por separado: «desde» y «hasta» tienen que ser del mismo trimestre.", "mal");
    if ([efectivo, tarjeta, gastos].some((x) => isNaN(x) || x < 0) || efectivo + tarjeta <= 0) return mostrar("Revisa los importes.", "mal");
    // No se puede solapar con días que ya tienen cierre en la app ni con otras cargas de la misma caja
    try {
      const col = caja === 1 ? "cierres" : "cierresCaja2";
      const sc = await getDocs(query(collection(db, col), where("fecha", ">=", desde), where("fecha", "<=", hasta)));
      const dias = [];
      sc.forEach((d) => { if (!d.data().anulado) dias.push(fechaCorta(d.data().fecha)); });
      if (dias.length) return mostrar(`Esos días ya tienen cierre en la app (${dias.join(", ")}). Carga solo los días anteriores, para no contarlos dos veces.`, "mal");
    } catch (e) { /* seguimos */ }
    const solapa = lista.find((v) => !v.anulado && v.caja === caja && v.desde <= hasta && v.hasta >= desde);
    if (solapa) return mostrar(`Se solapa con otra carga de la caja ${caja} (${fechaCorta(solapa.desde)} a ${fechaCorta(solapa.hasta)}).`, "mal");
    if (!confirm(`¿Guardar ventas de la caja ${caja} del ${fechaCorta(desde)}${hasta !== desde ? " al " + fechaCorta(hasta) : ""} por ${eur(efectivo + tarjeta)}?`)) return;
    try {
      await setDoc(doc(collection(db, "ventasPrevias")), {
        caja, desde, hasta, efectivo, tarjeta, gastos, nota: $("pNota").value.trim(), anulado: false,
        autorUid: estado.usuario.uid, autorNombre: estado.usuario.nombre, creadoEn: serverTimestamp()
      });
      await pintarPrevias(cont);
      mostrar("Guardado.", "ok");
    } catch (e) { mostrar("No se ha podido guardar: " + traducirError(e.code || e.message), "mal"); }
  });
  activarAnular(cont, "ventasPrevias", () => pintarPrevias(cont));
}
