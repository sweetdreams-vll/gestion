// =============================================================
// MÓDULO GASTOS Y TERCEROS:
// - Otros gastos que no son facturas de proveedor (cuotas de autónomos, seguros,
//   tasas, comisiones del banco, nóminas…), con botón para repetir los de cada mes.
// - Tipo de gasto de cada proveedor (los mismos códigos que usa la gestoría).
// - Informe trimestral de operaciones con terceros, como el de la gestoría.
// =============================================================
import {
  db, estado, $, esc, eur, leerEur, centimosATexto, mostrar, traducirError, iso, ms, vigentes
} from "./nucleo.js?v=2";
import {
  collection, doc, getDocs, setDoc, updateDoc, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Tipos de gasto. El código es el que usa la gestoría en su listado (columna T.C.), cuando se conoce.
const TIPOS = [
  { id: "mercancia", codigo: "2", nombre: "Compras de mercancía", iva: 21 },
  { id: "alquiler", codigo: "5", nombre: "Alquiler del local", iva: 21 },
  { id: "profesionales", codigo: "9", nombre: "Gestoría y profesionales", iva: 21 },
  { id: "luz", codigo: "30", nombre: "Luz", iva: 21 },
  { id: "agua", codigo: "31", nombre: "Agua", iva: 10 },
  { id: "combustible", codigo: "32", nombre: "Combustible", iva: 21 },
  { id: "telefono", codigo: "33", nombre: "Teléfono e internet", iva: 21 },
  { id: "reta", codigo: "29", nombre: "Cuotas de autónomos (RETA)", iva: 0 },
  { id: "sueldos", codigo: "1", nombre: "Sueldos y salarios", iva: 0 },
  { id: "segsocial", codigo: "3", nombre: "Seguridad Social de la empresa", iva: 0 },
  { id: "seguros", codigo: "", nombre: "Seguros", iva: 0 },
  { id: "tasas", codigo: "", nombre: "Tasas e impuestos", iva: 0 },
  { id: "banco", codigo: "", nombre: "Comisiones del banco", iva: 0 },
  { id: "mantenimiento", codigo: "", nombre: "Reparaciones y mantenimiento", iva: 21 },
  { id: "publicidad", codigo: "", nombre: "Publicidad", iva: 21 },
  { id: "otros", codigo: "", nombre: "Otros gastos", iva: 21 }
];
const TIPO = Object.fromEntries(TIPOS.map((t) => [t.id, t]));
const nombreTipo = (id) => { const t = TIPO[id] || TIPO.otros; return (t.codigo ? t.codigo + " · " : "") + t.nombre; };

// Gastos fijos que se proponen desde el principio
const PLANTILLAS_INICIALES = [
  { tipo: "reta", tercero: "TGSS Tesorería General de la Seguridad Social", nif: "Q2827003A", concepto: "Cuota RETA Brian", base: 30260, ivaTipo: 0 },
  { tipo: "reta", tercero: "TGSS Tesorería General de la Seguridad Social", nif: "Q2827003A", concepto: "Cuota RETA Milito", base: 30260, ivaTipo: 0 }
];
// Empresa de las dianas, según el listado de la gestoría de 2023 (confirmar si sigue siendo la misma)
const DIANAS = { tercero: "EVANER DARTS MS, S.L.", nif: "B47698907" };

export const moduloGastos = {
  id: "gastos",
  titulo: "Gastos y terceros",
  descripcion: "Gastos fijos (autónomos, seguros, luz…), tipos de proveedor e informe para la gestoría",
  icono: "",
  enBarra: false,
  roles: ["socio"],
  pestanas: [
    { id: "gastos", titulo: "Otros gastos" },
    { id: "proveedores", titulo: "Tipo de proveedor" },
    { id: "informe", titulo: "Informe trimestral" }
  ],
  render: ({ sub, resto, cont }) => {
    if (sub === "proveedores") return pintarTiposProveedor(cont);
    if (sub === "informe") return pintarInforme(cont, resto[0]);
    return pintarGastos(cont);
  }
};

// ---------- Estilos ----------
(function () {
  if (document.getElementById("css-gastos")) return;
  const s = document.createElement("style");
  s.id = "css-gastos";
  s.textContent = `
    .plantilla { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:8px 0; border-bottom:1px solid var(--borde); }
    .plantilla:last-child { border-bottom:none; }
    .plantilla button { width:auto; margin:0; padding:8px 12px; font-size:.85rem; }
    .plantilla small { display:block; color:var(--suave); }
    .inf-tabla { width:100%; border-collapse:collapse; font-size:.8rem; }
    .inf-tabla th, .inf-tabla td { padding:5px 4px; border-bottom:1px solid var(--borde); text-align:left; vertical-align:top; }
    .inf-tabla td.num, .inf-tabla th.num { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
    .inf-tabla tr.subtotal td { font-weight:700; border-bottom:2px solid var(--borde); }
    .inf-scroll { overflow-x:auto; }
    .trim-nav { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    .trim-nav a { text-decoration:none; color:var(--texto); background:var(--panel2); border:1px solid var(--borde); border-radius:10px; padding:8px 14px; }
    .badge { display:inline-block; font-size:.75rem; padding:2px 8px; border-radius:20px; margin-left:6px; font-weight:400; }
    .badge.anulada { background:var(--rojoF); }
    @media print {
      :root { --fondo:#fff; --panel:#fff; --panel2:#f2f2f2; --texto:#000; --suave:#444; --borde:#bbb; }
      body { background:#fff; color:#000; padding:0; }
      .barra, #pestanas, header, .pie, .no-imprimir, #mensaje { display:none !important; }
      .panel { break-inside:auto; border-color:#bbb; }
      .inf-tabla { font-size:9pt; }
    }
  `;
  document.head.appendChild(s);
})();

// ---------- Utilidades ----------
const fechaCorta = (t) => (t ? t.split("-").reverse().join("/") : "");
const num2 = (c) => (c / 100).toFixed(2).replace(".", ",");
const baseDe = (total, tipo) => Math.round(total / (1 + tipo / 100));
function trimestreDe(fecha) { const [y, m] = fecha.split("-").map(Number); return `${y}-${Math.floor((m - 1) / 3) + 1}`; }
function limites(clave) {
  const [y, t] = clave.split("-").map(Number);
  const mesIni = (t - 1) * 3 + 1;
  return {
    desde: `${y}-${String(mesIni).padStart(2, "0")}-01`,
    hasta: iso(new Date(y, mesIni + 2, 0)),
    meses: [0, 1, 2].map((i) => `${y}-${String(mesIni + i).padStart(2, "0")}`)
  };
}
function claveVecina(clave, paso) {
  let [y, t] = clave.split("-").map(Number);
  t += paso;
  if (t < 1) { t = 4; y--; }
  if (t > 4) { t = 1; y++; }
  return `${y}-${t}`;
}
const nombreTrim = (clave) => { const [y, t] = clave.split("-"); return `${t}.º trimestre de ${y}`; };
function opcionesTipo(sel) {
  return TIPOS.map((t) => `<option value="${t.id}" ${t.id === sel ? "selected" : ""}>${esc(nombreTipo(t.id))}</option>`).join("");
}

// =============================================================
// OTROS GASTOS
// =============================================================
async function pintarGastos(cont) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const s = await getDocs(collection(db, "gastos"));
  const lista = [];
  s.forEach((d) => lista.push({ id: d.id, ...d.data() }));
  lista.sort((a, b) => b.fecha.localeCompare(a.fecha) || ms(b.creadoEn) - ms(a.creadoEn));

  // Plantillas: el último gasto de cada tipo + tercero + concepto; si aún no hay, las iniciales
  const plantillas = [];
  const vistas = new Set();
  lista.filter((g) => !g.anulado).forEach((g) => {
    const k = `${g.tipo}|${g.tercero}|${g.concepto}`;
    if (vistas.has(k)) return;
    vistas.add(k);
    plantillas.push(g);
  });
  PLANTILLAS_INICIALES.forEach((p) => {
    const k = `${p.tipo}|${p.tercero}|${p.concepto}`;
    if (!vistas.has(k)) plantillas.push(p);
  });
  const mesActual = iso(new Date()).slice(0, 7);
  const yaEsteMes = (p) => lista.some((g) => !g.anulado && g.tipo === p.tipo && g.tercero === p.tercero && g.concepto === p.concepto && g.fecha.startsWith(mesActual));
  const terceros = [...new Set(lista.map((g) => g.tercero).filter(Boolean))];

  cont.innerHTML = `
    <div class="panel">
      <h2>Gastos de cada mes</h2>
      <p class="suave" style="margin-top:0;line-height:1.5">Pulsa «Apuntar» y se guarda igual que el último, con la fecha de hoy. Luz, agua, internet o gestoría, si os mandan factura, regístralos mejor en Compras con foto.</p>
      ${plantillas.map((p, k) => `
        <div class="plantilla">
          <span>${esc(p.concepto || nombreTipo(p.tipo))}<small>${esc(p.tercero || "")} · ${eur(p.base + Math.round(p.base * (p.ivaTipo || 0) / 100))}${yaEsteMes(p) ? " · ya apuntado este mes" : ""}</small></span>
          <button class="${yaEsteMes(p) ? "sec" : ""} gRepetir" data-k="${k}" type="button">Apuntar</button>
        </div>`).join("")}
    </div>

    <div class="panel">
      <h2>Apuntar otro gasto</h2>
      <label for="gTipo">Tipo de gasto</label><select id="gTipo">${opcionesTipo("seguros")}</select>
      <div class="fila">
        <div><label for="gFecha">Fecha</label><input id="gFecha" type="date" value="${iso(new Date())}"></div>
        <div><label for="gIva">IVA %</label><select id="gIva"><option>0</option><option>4</option><option>10</option><option>21</option></select></div>
      </div>
      <label for="gTercero">A quién se paga</label><input id="gTercero" list="gListaTerceros" placeholder="Aseguradora, Ayuntamiento, banco…">
      <datalist id="gListaTerceros">${terceros.map((t) => `<option value="${esc(t)}"></option>`).join("")}</datalist>
      <label for="gNif">CIF o NIF (opcional)</label><input id="gNif" autocapitalize="characters">
      <label for="gConcepto">Concepto</label><input id="gConcepto" placeholder="Seguro del local, tasa de basuras…">
      <label for="gImporte">Importe total pagado (€)</label><input id="gImporte" inputmode="decimal" placeholder="0,00">
      <small class="nota" id="gDesglose"></small>
      <label for="gNumero">Nº de recibo o factura (opcional)</label><input id="gNumero">
      <button id="gGuardar" type="button">Guardar gasto</button>
      <small class="nota">Se entiende pagado por banco. Si se pagó en efectivo de la caja roja, apúntalo también como salida en Caja roja.</small>
    </div>

    <div class="semana"><h3>Registrados</h3>
      ${lista.length ? lista.slice(0, 60).map((g) => `
        <div class="item">
          <div class="top"><span>${esc(g.concepto || nombreTipo(g.tipo))}${g.anulado ? '<span class="badge anulada">anulado</span>' : ""}</span><span>${eur(g.total)}</span></div>
          <div class="sub"><span>${esc(fechaCorta(g.fecha))} · ${esc(nombreTipo(g.tipo))} · ${esc(g.tercero || "")}</span>
            ${g.anulado ? "" : `<button class="sec gAnular" data-id="${esc(g.id)}" type="button" style="width:auto;margin:0;padding:4px 10px;font-size:.8rem">Anular</button>`}</div>
        </div>`).join("") : '<p class="suave">Todavía no hay gastos apuntados.</p>'}
    </div>`;

  const ponerIva = () => { $("gIva").value = String((TIPO[$("gTipo").value] || TIPO.otros).iva); desglose(); };
  const desglose = () => {
    const t = leerEur($("gImporte").value), tipo = Number($("gIva").value);
    $("gDesglose").textContent = t && !isNaN(t) && tipo ? `Base ${eur(baseDe(t, tipo))} + IVA ${eur(t - baseDe(t, tipo))}` : "";
  };
  $("gTipo").addEventListener("change", ponerIva);
  $("gIva").addEventListener("change", desglose);
  $("gImporte").addEventListener("input", desglose);
  ponerIva();

  const guardar = async (datos) => {
    await setDoc(doc(collection(db, "gastos")), {
      ...datos, anulado: false,
      autorUid: estado.usuario.uid, autorNombre: estado.usuario.nombre, creadoEn: serverTimestamp()
    });
  };

  cont.querySelectorAll(".gRepetir").forEach((b) => b.addEventListener("click", async () => {
    const p = plantillas[Number(b.dataset.k)];
    const cuota = Math.round(p.base * (p.ivaTipo || 0) / 100);
    const aviso = yaEsteMes(p) ? "\n\nOjo: este mes ya está apuntado." : "";
    if (!confirm(`¿Apuntar «${p.concepto}» de hoy por ${eur(p.base + cuota)}?${aviso}`)) return;
    try {
      await guardar({ fecha: iso(new Date()), tipo: p.tipo, tercero: p.tercero || "", nif: p.nif || "", concepto: p.concepto || "", base: p.base, ivaTipo: p.ivaTipo || 0, cuota, total: p.base + cuota, numero: "" });
      await pintarGastos(cont);
      mostrar("Gasto apuntado.", "ok");
    } catch (e) { mostrar("No se ha podido guardar: " + traducirError(e.code || e.message), "mal"); }
  }));

  $("gGuardar").addEventListener("click", async () => {
    const total = leerEur($("gImporte").value), ivaTipo = Number($("gIva").value);
    const fecha = $("gFecha").value, tercero = $("gTercero").value.trim(), concepto = $("gConcepto").value.trim();
    if (!fecha || !tercero || !concepto) return mostrar("Faltan la fecha, a quién se paga o el concepto.", "mal");
    if (!total || isNaN(total) || total <= 0) return mostrar("Escribe el importe pagado.", "mal");
    const base = baseDe(total, ivaTipo);
    if (!confirm(`¿Guardar «${concepto}» (${nombreTipo($("gTipo").value)}) por ${eur(total)}?`)) return;
    try {
      await guardar({ fecha, tipo: $("gTipo").value, tercero, nif: $("gNif").value.trim().toUpperCase(), concepto, base, ivaTipo, cuota: total - base, total, numero: $("gNumero").value.trim() });
      await pintarGastos(cont);
      mostrar("Gasto guardado.", "ok");
    } catch (e) { mostrar("No se ha podido guardar: " + traducirError(e.code || e.message), "mal"); }
  });

  cont.querySelectorAll(".gAnular").forEach((b) => b.addEventListener("click", async () => {
    const motivo = prompt("¿Por qué se anula?");
    if (!motivo || !motivo.trim()) return;
    try {
      await updateDoc(doc(db, "gastos", b.dataset.id), { anulado: true, motivoAnulacion: motivo.trim(), anuladoPor: estado.usuario.nombre, anuladoEn: serverTimestamp() });
      await pintarGastos(cont);
      mostrar("Anulado.", "ok");
    } catch (e) { mostrar("No se ha podido anular: " + traducirError(e.code || e.message), "mal"); }
  }));
}

// =============================================================
// TIPO DE GASTO DE CADA PROVEEDOR
// =============================================================
async function pintarTiposProveedor(cont) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const s = await getDocs(collection(db, "proveedores"));
  const lista = [];
  s.forEach((d) => lista.push({ id: d.id, ...d.data() }));
  lista.sort((a, b) => a.nombre.localeCompare(b.nombre));
  cont.innerHTML = `
    <div class="panel">
      <p class="suave" style="margin:0;line-height:1.5">Elige una vez el tipo de gasto de cada proveedor y todas sus facturas se clasificarán solas en el informe. Si no eliges nada, cuenta como «Compras de mercancía». Los números son los códigos que usa la gestoría.</p>
    </div>
    ${lista.length ? `<div class="panel">${lista.map((p) => `
      <div class="plantilla" data-id="${esc(p.id)}">
        <span>${esc(p.nombre)}<small>${esc(p.cif || "sin CIF")}</small></span>
        <select class="pTipo" style="width:55%">${opcionesTipo(p.tipoGasto || "mercancia")}</select>
      </div>`).join("")}</div>` : '<div class="panel">Todavía no hay proveedores.</div>'}`;

  cont.querySelectorAll(".pTipo").forEach((sel) => sel.addEventListener("change", async () => {
    const id = sel.closest("[data-id]").dataset.id;
    try {
      await updateDoc(doc(db, "proveedores", id), { tipoGasto: sel.value, actualizadoPor: estado.usuario.nombre, actualizadoEn: serverTimestamp() });
      mostrar("Guardado: " + nombreTipo(sel.value), "ok");
    } catch (e) { mostrar("No se ha podido guardar: " + traducirError(e.code || e.message), "mal"); }
  }));
}

// =============================================================
// INFORME DE OPERACIONES CON TERCEROS (como el de la gestoría)
// =============================================================
async function cargarInforme(clave) {
  const L = limites(clave);
  const [sc, sk, sf, sp, si, sa, sg] = await Promise.all([
    getDocs(query(collection(db, "cierres"), where("fecha", ">=", L.desde), where("fecha", "<=", L.hasta))),
    getDocs(collection(db, "correcciones")),
    getDocs(query(collection(db, "facturas"), where("fecha", ">=", L.desde), where("fecha", "<=", L.hasta))),
    getDocs(collection(db, "proveedores")),
    getDocs(collection(db, "ingresos")),
    getDocs(collection(db, "alquileres")),
    getDocs(collection(db, "gastos"))
  ]);
  const corr = {};
  sk.forEach((d) => { const c = d.data(); (corr[c.cierreId] ||= []).push(c); });
  let ventas = 0;
  sc.forEach((d) => { ventas += vigentes(d.data(), corr[d.id]).ticketTotal; });
  const ventasBase = baseDe(ventas, 10);

  const tipoProv = {};
  sp.forEach((d) => { tipoProv[d.id] = d.data().tipoGasto || "mercancia"; });

  const ingresos = [];
  ingresos.push({ fecha: L.hasta, numero: "", tercero: "CLIENTES VARIOS", nif: "", base: ventasBase, cuota: ventas - ventasBase, total: ventas, nota: "Ventas del " + nombreTrim(clave) + " (cierres de caja)" });
  si.forEach((d) => {
    const x = d.data();
    if (x.anulado || x.fecha < L.desde || x.fecha > L.hasta) return;
    const esDiana = /diana|dardo/i.test(x.concepto || "");
    ingresos.push({ fecha: x.fecha, numero: "", tercero: esDiana ? DIANAS.tercero : x.concepto, nif: esDiana ? DIANAS.nif : "", base: x.base, cuota: x.cuota, total: x.base + x.cuota, nota: x.concepto });
  });

  // Pagos: una fila por factura y tipo de IVA (igual que la gestoría)
  const pagos = [];
  sf.forEach((d) => {
    const f = d.data();
    if (f.anulada || f.tipo === "albaran") return;
    const tipo = tipoProv[f.proveedorId] || "mercancia";
    const bases = (f.bases || []).length ? f.bases : [{ base: f.totalBase || f.total, cuota: f.totalIva || 0 }];
    bases.forEach((b) => pagos.push({ tipo, fecha: f.fecha, numero: f.numero, tercero: f.proveedorNombre, nif: f.cif || "", base: b.base, cuota: b.cuota, total: b.base + b.cuota, nota: "" }));
  });
  sa.forEach((d) => {
    const a = d.data();
    if (a.anulado || !L.meses.includes(a.mes)) return;
    pagos.push({ tipo: "alquiler", fecha: a.fechaFactura || a.mes + "-01", numero: a.numero || "", tercero: a.arrendador || "Alquiler del local", nif: a.cif || "", base: a.base, cuota: a.cuota, total: a.base + a.cuota - a.retencion, nota: "Retención " + num2(a.retencion) + " €" });
  });
  sg.forEach((d) => {
    const g = d.data();
    if (g.anulado || g.fecha < L.desde || g.fecha > L.hasta) return;
    pagos.push({ tipo: g.tipo, fecha: g.fecha, numero: g.numero || "", tercero: g.tercero, nif: g.nif || "", base: g.base, cuota: g.cuota, total: g.total, nota: g.concepto });
  });
  // Orden: por tipo (como en la lista de tipos), luego tercero, luego fecha
  const orden = Object.fromEntries(TIPOS.map((t, i) => [t.id, i]));
  pagos.sort((a, b) => (orden[a.tipo] ?? 99) - (orden[b.tipo] ?? 99) || a.tercero.localeCompare(b.tercero) || a.fecha.localeCompare(b.fecha));
  return { L, ingresos, pagos };
}

function agruparPorTercero(filas) {
  const g = [];
  filas.forEach((f) => {
    const ult = g[g.length - 1];
    if (ult && ult.tercero === f.tercero && ult.tipo === f.tipo) ult.filas.push(f);
    else g.push({ tercero: f.tercero, tipo: f.tipo, filas: [f] });
  });
  return g;
}
const suma = (filas, k) => filas.reduce((s, f) => s + (f[k] || 0), 0);

function tablaFilas(grupos, conTipo) {
  return grupos.map((grp) => `
    ${grp.filas.map((f) => `<tr>
      <td>${esc(fechaCorta(f.fecha))}</td>
      ${conTipo ? `<td>${esc((TIPO[f.tipo] || TIPO.otros).codigo || "")}</td>` : ""}
      <td>${esc(f.tercero)}${f.nota ? `<br><span class="suave">${esc(f.nota)}</span>` : ""}</td>
      <td>${esc(f.nif)}</td>
      <td>${esc(f.numero)}</td>
      <td class="num">${num2(f.base)}</td>
      <td class="num">${f.cuota ? num2(f.cuota) : ""}</td>
      <td class="num">${num2(f.total)}</td>
    </tr>`).join("")}
    ${grp.filas.length > 1 ? `<tr class="subtotal"><td colspan="${conTipo ? 5 : 4}">${esc(grp.tercero)}</td><td class="num">${num2(suma(grp.filas, "base"))}</td><td class="num">${num2(suma(grp.filas, "cuota"))}</td><td class="num">${num2(suma(grp.filas, "total"))}</td></tr>` : ""}`).join("");
}

async function pintarInforme(cont, claveParam) {
  const clave = /^\d{4}-[1-4]$/.test(claveParam || "") ? claveParam : trimestreDe(iso(new Date()));
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const d = await cargarInforme(clave);

  const porTipo = {};
  d.pagos.forEach((p) => { const x = (porTipo[p.tipo] ||= { base: 0, cuota: 0, total: 0 }); x.base += p.base; x.cuota += p.cuota; x.total += p.total; });
  const cab = (conTipo) => `<tr><th>Fecha</th>${conTipo ? "<th>T.C.</th>" : ""}<th>Tercero</th><th>CIF/NIF</th><th>Factura</th><th class="num">Base</th><th class="num">IVA</th><th class="num">Total</th></tr>`;

  cont.innerHTML = `
    <div class="panel no-imprimir">
      <div class="trim-nav">
        <a href="#/gastos/informe/${claveVecina(clave, -1)}" aria-label="Trimestre anterior">‹</a>
        <strong>${esc(nombreTrim(clave))}</strong>
        <a href="#/gastos/informe/${claveVecina(clave, 1)}" aria-label="Trimestre siguiente">›</a>
      </div>
      <button id="iCompartir" type="button">Compartir en Excel</button>
      <button class="sec" id="iPdf" type="button">Imprimir o guardar en PDF</button>
    </div>

    <div class="panel">
      <h2>Operaciones con terceros · Sweet Dreams, C.B. · ${esc(nombreTrim(clave))}</h2>
      <h3 style="margin:8px 0">Ingresos</h3>
      <div class="inf-scroll"><table class="inf-tabla">${cab(false)}${tablaFilas(agruparPorTercero(d.ingresos), false)}
        <tr class="subtotal"><td colspan="4">Total ingresos</td><td class="num">${num2(suma(d.ingresos, "base"))}</td><td class="num">${num2(suma(d.ingresos, "cuota"))}</td><td class="num">${num2(suma(d.ingresos, "total"))}</td></tr>
      </table></div>

      <h3 style="margin:16px 0 8px">Pagos</h3>
      ${d.pagos.length ? `<div class="inf-scroll"><table class="inf-tabla">${cab(true)}${tablaFilas(agruparPorTercero(d.pagos), true)}
        <tr class="subtotal"><td colspan="5">Total pagos</td><td class="num">${num2(suma(d.pagos, "base"))}</td><td class="num">${num2(suma(d.pagos, "cuota"))}</td><td class="num">${num2(suma(d.pagos, "total"))}</td></tr>
      </table></div>` : '<p class="suave">No hay pagos registrados en este trimestre.</p>'}
    </div>

    <div class="panel">
      <h2>Resumen por tipo de gasto</h2>
      <div class="resumen">
        ${TIPOS.filter((t) => porTipo[t.id]).map((t) => `<div><span>${esc(nombreTipo(t.id))}</span><strong>${eur(porTipo[t.id].base)}${porTipo[t.id].cuota ? " + IVA " + eur(porTipo[t.id].cuota) : ""}</strong></div>`).join("") || "<div><span class='suave'>Sin gastos</span></div>"}
        <div><span>Total gastos (base)</span><strong>${eur(suma(d.pagos, "base"))}</strong></div>
      </div>
      <small class="nota">Las facturas se clasifican según el tipo de cada proveedor (pestaña «Tipo de proveedor»). Los albaranes sin factura no aparecen.</small>
    </div>`;

  $("iPdf").addEventListener("click", () => window.print());
  $("iCompartir").addEventListener("click", async () => {
    const celda = (v) => { const s = String(v ?? ""); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const filas = [["Apartado", "Fecha", "T.C.", "Tipo de gasto", "Tercero", "CIF/NIF", "Factura", "Base", "IVA", "Total", "Nota"]];
    d.ingresos.forEach((f) => filas.push(["INGRESOS", fechaCorta(f.fecha), "", "", f.tercero, f.nif, f.numero, num2(f.base), num2(f.cuota), num2(f.total), f.nota]));
    d.pagos.forEach((f) => filas.push(["PAGOS", fechaCorta(f.fecha), (TIPO[f.tipo] || TIPO.otros).codigo, (TIPO[f.tipo] || TIPO.otros).nombre, f.tercero, f.nif, f.numero, num2(f.base), num2(f.cuota), num2(f.total), f.nota]));
    const texto = "\ufeff" + filas.map((f) => f.map(celda).join(";")).join("\r\n");
    const archivo = new File([texto], `operaciones_terceros_${clave.replace("-", "_T")}.csv`, { type: "text/csv" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
        await navigator.share({ files: [archivo], title: "Operaciones con terceros " + nombreTrim(clave) });
        return;
      }
    } catch (e) { if (e.name === "AbortError") return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(archivo);
    a.download = archivo.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    mostrar("Archivo descargado en la carpeta de Descargas.", "ok");
  });
}
