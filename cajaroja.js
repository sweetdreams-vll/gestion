// =============================================================
// MÓDULO CAJA ROJA (versión 2): el efectivo guardado del bar.
// Entra: lo retirado en cada cierre y otras entradas (dinero sacado del banco…).
// Sale: facturas pagadas con la caja roja y otras salidas (ingresos en el banco…).
// Todo queda guardado: historial por recuentos y calendario por días,
// con el saldo antes y después de cada movimiento.
// =============================================================
import {
  db, estado, ICONOS, $, esc, eur, eurSigno, leerEur, mostrar, traducirError,
  ms, iso, vigentes, claseDescuadre, textoDescuadre
} from "./nucleo.js?v=2";
import {
  collection, doc, getDocs, setDoc, updateDoc, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const moduloCajaRoja = {
  id: "cajaroja",
  titulo: "Caja roja",
  descripcion: "Efectivo guardado: saldo, historial y calendario",
  icono: ICONOS.caja,
  enBarra: false,
  roles: ["socio"],
  pestanas: [
    { id: "saldo", titulo: "Saldo" },
    { id: "historial", titulo: "Historial" },
    { id: "calendario", titulo: "Calendario" },
    { id: "periodo", oculta: true, padre: "historial" },
    { id: "dia", oculta: true, padre: "calendario" }
  ],
  render: ({ sub, resto, cont }) => {
    if (sub === "historial") return pintarHistorial(cont);
    if (sub === "periodo") return pintarPeriodo(cont, resto[0]);
    if (sub === "calendario") return pintarCalendario(cont, resto[0]);
    if (sub === "dia") return pintarDia(cont, resto[0]);
    return pintarSaldo(cont);
  },
  inicio: tarjetaInicio
};

const SUGERENCIAS_ENTRADA = ["Dinero sacado del banco", "Devolución de un proveedor", "Otro"];
const SUGERENCIAS_SALIDA = ["Ingreso en el banco", "Pago sin factura en la app", "Otro"];
const DIAS_SEMANA = ["L", "M", "X", "J", "V", "S", "D"];

// ---------- Estilos propios ----------
(function () {
  if (document.getElementById("css-cajaroja")) return;
  const s = document.createElement("style");
  s.id = "css-cajaroja";
  s.textContent = `
    .cal { display:grid; grid-template-columns:repeat(7, 1fr); gap:4px; }
    .cal .cab { text-align:center; color:var(--suave); font-size:.75rem; padding:4px 0; }
    .cal a, .cal span.vacio { aspect-ratio:1; border-radius:8px; display:flex; flex-direction:column; align-items:center; justify-content:center; text-decoration:none; color:var(--texto); font-size:.85rem; }
    .cal a { background:var(--panel2); border:1px solid var(--borde); }
    .cal a.sin { opacity:.45; }
    .cal a.hoy { border-color:var(--rosa); }
    .cal small { font-size:.62rem; margin-top:2px; font-variant-numeric:tabular-nums; }
    .cal .r { width:6px; height:6px; border-radius:50%; background:var(--rosa); margin-top:2px; }
    .mes-nav { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:10px; }
    .mes-nav a { text-decoration:none; color:var(--texto); background:var(--panel2); border:1px solid var(--borde); border-radius:10px; padding:8px 14px; }
    .mov { border-bottom:1px solid var(--borde); padding:10px 0; }
    .mov:last-child { border-bottom:none; }
    .mov .top { display:flex; justify-content:space-between; gap:8px; }
    .mov .sub { display:flex; justify-content:space-between; gap:8px; color:var(--suave); font-size:.82rem; margin-top:3px; }
    .mov.anulado { opacity:.5; }
    .mov.anulado .top span:first-child { text-decoration:line-through; }
    .mov.conteo { background:var(--panel2); border-radius:10px; padding:10px; margin:6px 0; border-bottom:none; }
  `;
  document.head.appendChild(s);
})();

// ---------- Utilidades ----------
const fechaCorta = (t) => (t ? t.split("-").reverse().join("/") : "");
const diaDe = (cuando) => iso(new Date(cuando));
const horaTexto = (cuando) => new Date(cuando).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
const fechaHora = (cuando) => new Date(cuando).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const eurCorto = (c) => (c > 0 ? "+" : c < 0 ? "−" : "") + Math.round(Math.abs(c) / 100);

// =============================================================
// LÍNEA DE TIEMPO: todos los movimientos en orden, con su saldo
// =============================================================
async function cargarLinea() {
  const [sm, sc, sk, sf, sfEf] = await Promise.all([
    getDocs(collection(db, "cajaRoja")),
    getDocs(collection(db, "cierres")),
    getDocs(collection(db, "correcciones")),
    getDocs(query(collection(db, "facturas"), where("pagadaDesde", "==", "cajaRoja"))),
    getDocs(query(collection(db, "facturas"), where("efectivoCajaRoja", ">", 0)))
  ]);

  const corr = {};
  sk.forEach((d) => { const c = d.data(); (corr[c.cierreId] ||= []).push(c); });
  Object.values(corr).forEach((l) => l.sort((a, b) => ms(a.creadoEn) - ms(b.creadoEn)));

  const eventos = [];
  sm.forEach((d) => {
    const m = { id: d.id, ...d.data() };
    if (m.tipo === "recuento") {
      if (m.anulado) return;
      eventos.push({ tipo: "recuento", id: m.id, cuando: ms(m.creadoEn), importe: m.importe, texto: m.concepto && m.concepto !== "Recuento" ? m.concepto : "Recuento", quien: m.autorNombre });
    } else {
      eventos.push({
        tipo: "manual", id: m.id, cuando: ms(m.creadoEn),
        importe: m.tipo === "entrada" ? m.importe : -m.importe,
        texto: m.concepto, quien: m.autorNombre,
        anulado: !!m.anulado, motivo: m.motivoAnulacion || "", anuladoPor: m.anuladoPor || ""
      });
    }
  });
  sc.forEach((d) => {
    const c = d.data();
    const v = vigentes(c, corr[d.id]);
    eventos.push({ tipo: "cierre", id: d.id, cuando: ms(c.creadoEn), importe: v.aRetirar, texto: "Cierre del " + fechaCorta(c.fecha), quien: c.autorNombre });
  });
    // Facturas pagadas con la caja roja: entera o solo la parte en efectivo (pago mixto)
  const vistas = new Set();
  const anadirFactura = (d) => {
    if (vistas.has(d.id)) return;
    vistas.add(d.id);
    const f = d.data();
    if (f.anulada) return;
    const importe = typeof f.efectivoCajaRoja === "number" && f.efectivoCajaRoja > 0 ? f.efectivoCajaRoja : f.total;
    eventos.push({ tipo: "factura", id: d.id, cuando: ms(f.pagoEn), importe: -importe, texto: "Factura " + f.proveedorNombre + " " + f.numero + (f.pagadaDesde === "mixto" ? " (parte en efectivo)" : ""), quien: f.pagoPor || f.autorNombre });
  };
  sfEf.forEach(anadirFactura);
  sf.forEach(anadirFactura);
  eventos.sort((a, b) => a.cuando - b.cuando);

  // Recorrido: el saldo se conoce a partir del primer recuento; cada recuento lo fija de nuevo
  let saldo = null;
  let periodo = { clave: "antes", inicio: null, fin: null, eventos: [] };
  const periodos = [periodo];
  eventos.forEach((ev) => {
    if (ev.tipo === "recuento") {
      ev.esperado = saldo;
      ev.diferencia = saldo === null ? null : ev.importe - saldo;
      periodo.fin = ev;
      saldo = ev.importe;
      periodo = { clave: ev.id, inicio: ev, fin: null, eventos: [] };
      periodos.push(periodo);
    } else {
      ev.antes = saldo;
      if (!ev.anulado && saldo !== null) saldo += ev.importe;
      ev.despues = saldo;
      periodo.eventos.push(ev);
    }
  });
  const recuentos = eventos.filter((e) => e.tipo === "recuento");
  return {
    eventos,
    periodos: periodos.filter((p) => p.inicio || p.eventos.length),
    saldo,
    ultimo: recuentos[recuentos.length - 1] || null
  };
}

// Una línea del historial
function filaEvento(ev, conFecha = true) {
  const cuando = conFecha ? fechaHora(ev.cuando) : horaTexto(ev.cuando);
  if (ev.tipo === "recuento") {
    return `
      <div class="mov conteo">
        <div class="top"><strong>${esc(ev.texto)}: ${eur(ev.importe)}</strong><span class="${ev.diferencia === null ? "" : claseDescuadre(ev.diferencia)}">${ev.diferencia === null ? "Primer recuento" : textoDescuadre(ev.diferencia)}</span></div>
        <div class="sub"><span>${esc(cuando)}, ${esc(ev.quien || "")}</span><span>${ev.esperado === null ? "" : "Debería haber " + eur(ev.esperado)}</span></div>
      </div>`;
  }
  const origen = { cierre: "automático", factura: "factura", manual: "a mano" }[ev.tipo];
  return `
    <div class="mov ${ev.anulado ? "anulado" : ""}">
      <div class="top"><span>${esc(ev.texto)}</span><strong class="${ev.importe < 0 ? "neg" : "cero"}">${eurSigno(ev.importe)}</strong></div>
      <div class="sub"><span>${esc(cuando)}, ${esc(ev.quien || "")} · ${origen}</span>
        <span>${ev.antes === null ? "" : `${eur(ev.antes)} → ${eur(ev.despues)}`}</span></div>
      ${ev.anulado ? `<div class="sub"><span>Anulado por ${esc(ev.anuladoPor)}: ${esc(ev.motivo)}</span></div>` : ""}
      ${ev.tipo === "manual" && !ev.anulado ? `<button class="sec mAnular" data-id="${esc(ev.id)}" type="button" style="width:auto;margin:6px 0 0;padding:4px 10px;font-size:.8rem">Anular</button>` : ""}
    </div>`;
}

// Botones de anular movimientos hechos a mano (no se borran: quedan tachados con el motivo)
function activarAnular(cont, repintar) {
  cont.querySelectorAll(".mAnular").forEach((b) => b.addEventListener("click", async () => {
    const motivo = prompt("¿Por qué se anula este movimiento?");
    if (!motivo || !motivo.trim()) return;
    try {
      await updateDoc(doc(db, "cajaRoja", b.dataset.id), {
        anulado: true, motivoAnulacion: motivo.trim(), anuladoPor: estado.usuario.nombre, anuladoEn: serverTimestamp()
      });
      await repintar();
      mostrar("Movimiento anulado. Sigue en el historial, tachado.", "ok");
    } catch (e) {
      mostrar("No se ha podido anular: " + traducirError(e.code || e.message), "mal");
    }
  }));
}

// =============================================================
// INICIO
// =============================================================
async function tarjetaInicio(cont) {
  const r = await cargarLinea();
  cont.innerHTML = `
    <div class="panel">
      <h2>Caja roja</h2>
      <div class="metricas">
        <div><small>Debería haber</small><strong>${r.saldo === null ? "—" : eur(r.saldo)}</strong></div>
        <div><small>Último recuento</small><strong>${r.ultimo ? esc(fechaCorta(diaDe(r.ultimo.cuando))) : "Ninguno"}</strong></div>
      </div>
      <a class="boton sec" href="#/cajaroja/saldo">Ver caja roja</a>
    </div>`;
}

// =============================================================
// SALDO, RECUENTO Y NUEVO MOVIMIENTO
// =============================================================
async function pintarSaldo(cont) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const r = await cargarLinea();
  const actual = r.periodos[r.periodos.length - 1];
  const u = r.ultimo;
  cont.innerHTML = `
    <div class="panel">
      <h2>Debería haber</h2>
      <p style="font-size:2rem;font-weight:700;margin:0">${r.saldo === null ? "—" : eur(r.saldo)}</p>
      ${u
        ? `<p class="suave" style="margin-bottom:0">Último recuento: ${esc(fechaHora(u.cuando))}, ${esc(u.quien)}, ${eur(u.importe)}. Desde entonces: ${actual.eventos.filter((e) => !e.anulado).length} movimientos.</p>
           <a class="boton sec" href="#/cajaroja/periodo/${encodeURIComponent(actual.clave)}">Ver movimientos desde el último recuento</a>`
        : `<div class="estado sobra" style="font-weight:400">Todavía no habéis contado la caja roja. Haz el primer recuento para empezar a controlarla.</div>`}
    </div>

    <div class="panel">
      <h2>Contar la caja roja</h2>
      <label for="rImporte">Dinero contado (€)</label>
      <input id="rImporte" inputmode="decimal" placeholder="0,00">
      <label for="rNota">Nota (opcional)</label>
      <input id="rNota" placeholder="Recuento del lunes">
      <button id="rGuardarRecuento" type="button">Guardar recuento</button>
    </div>

    <div class="panel">
      <h2>Apuntar entrada o salida</h2>
      <small class="nota" style="margin-top:0">Lo retirado en cada cierre y las facturas pagadas con la caja roja se apuntan solos. Aquí va todo lo demás.</small>
      <label for="mTipo">Tipo</label>
      <select id="mTipo">
        <option value="entrada">Entrada de dinero</option>
        <option value="salida">Salida de dinero</option>
      </select>
      <label for="mConcepto">Concepto</label>
      <input id="mConcepto" list="mSugerencias" placeholder="Dinero sacado del banco">
      <datalist id="mSugerencias"></datalist>
      <label for="mImporte">Importe (€)</label>
      <input id="mImporte" inputmode="decimal" placeholder="0,00">
      <button id="mGuardar" type="button">Guardar movimiento</button>
    </div>`;

  const ponerSugerencias = () => {
    const l = $("mTipo").value === "entrada" ? SUGERENCIAS_ENTRADA : SUGERENCIAS_SALIDA;
    $("mSugerencias").innerHTML = l.map((x) => `<option value="${esc(x)}"></option>`).join("");
    $("mConcepto").placeholder = l[0];
  };
  $("mTipo").addEventListener("change", ponerSugerencias);
  ponerSugerencias();

  $("rGuardarRecuento").addEventListener("click", async () => {
    const importe = leerEur($("rImporte").value);
    if (importe === null || isNaN(importe)) return mostrar("Escribe el dinero contado en euros.", "mal");
    const dif = r.saldo === null ? null : importe - r.saldo;
    const texto = dif === null ? "\n\nEs el primer recuento: desde ahora se controlará la caja roja." : "\n\nResultado: " + textoDescuadre(dif);
    if (!confirm("¿Guardar el recuento de " + eur(importe) + "?" + texto)) return;
    try {
      await setDoc(doc(collection(db, "cajaRoja")), {
        tipo: "recuento", importe, teorico: r.saldo, diferencia: dif === null ? 0 : dif,
        concepto: $("rNota").value.trim() || "Recuento",
        anulado: false, autorUid: estado.usuario.uid, autorNombre: estado.usuario.nombre, creadoEn: serverTimestamp()
      });
      await pintarSaldo(cont);
      mostrar(dif === null ? "Primer recuento guardado." : "Recuento guardado. " + textoDescuadre(dif) + ".", dif === null || dif === 0 ? "ok" : "mal");
    } catch (e) {
      mostrar("No se ha podido guardar: " + traducirError(e.code || e.message), "mal");
    }
  });

  $("mGuardar").addEventListener("click", async () => {
    const tipo = $("mTipo").value;
    const concepto = $("mConcepto").value.trim();
    const importe = leerEur($("mImporte").value);
    if (!concepto) return mostrar("Escribe el concepto.", "mal");
    if (importe === null || isNaN(importe) || importe <= 0) return mostrar("Escribe un importe válido.", "mal");
    if (!confirm(`¿Guardar ${tipo === "entrada" ? "entrada" : "salida"} de ${eur(importe)}: ${concepto}?`)) return;
    try {
      await setDoc(doc(collection(db, "cajaRoja")), {
        tipo, concepto, importe, anulado: false,
        autorUid: estado.usuario.uid, autorNombre: estado.usuario.nombre, creadoEn: serverTimestamp()
      });
      await pintarSaldo(cont);
      mostrar("Movimiento guardado.", "ok");
    } catch (e) {
      mostrar("No se ha podido guardar: " + traducirError(e.code || e.message), "mal");
    }
  });
}

// =============================================================
// HISTORIAL POR RECUENTOS (opción 1)
// =============================================================
async function pintarHistorial(cont) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const r = await cargarLinea();
  if (!r.periodos.length) {
    cont.innerHTML = '<div class="panel">Todavía no hay movimientos ni recuentos.</div>';
    return;
  }
  const tarjetas = [...r.periodos].reverse().map((p) => {
    const validos = p.eventos.filter((e) => !e.anulado);
    const neto = validos.reduce((s, e) => s + e.importe, 0);
    const desde = p.inicio ? fechaHora(p.inicio.cuando) : "el principio";
    const hasta = p.fin ? fechaHora(p.fin.cuando) : "ahora";
    const resultado = p.fin
      ? (p.fin.diferencia === null ? "Primer recuento" : textoDescuadre(p.fin.diferencia))
      : (r.saldo === null ? "" : "Debería haber " + eur(r.saldo));
    const clase = p.fin && p.fin.diferencia !== null ? claseDescuadre(p.fin.diferencia) : "";
    return `
      <a class="item" href="#/cajaroja/periodo/${encodeURIComponent(p.clave)}">
        <div class="top"><span>${esc(desde)} → ${esc(hasta)}</span><span>${eurSigno(neto)}</span></div>
        <div class="sub"><span>${validos.length} movimiento${validos.length === 1 ? "" : "s"}${p.inicio ? ", empezó con " + eur(p.inicio.importe) : ""}</span><span class="${clase}">${esc(resultado)}</span></div>
      </a>`;
  }).join("");
  cont.innerHTML = `
    <p class="suave" style="margin-top:0;line-height:1.5">Cada tramo va de un recuento al siguiente. Pulsa uno para ver todos sus movimientos con el saldo antes y después.</p>
    ${tarjetas}`;
}

async function pintarPeriodo(cont, clave) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const r = await cargarLinea();
  const p = r.periodos.find((x) => x.clave === clave);
  if (!p) { cont.innerHTML = '<a class="volver" href="#/cajaroja/historial">‹ Historial</a><div class="panel">No se ha encontrado ese tramo.</div>'; return; }
  const validos = p.eventos.filter((e) => !e.anulado);
  const entradas = validos.filter((e) => e.importe > 0).reduce((s, e) => s + e.importe, 0);
  const salidas = validos.filter((e) => e.importe < 0).reduce((s, e) => s + e.importe, 0);
  const finEsperado = p.fin ? p.fin.esperado : r.saldo;

  cont.innerHTML = `
    <a class="volver" href="#/cajaroja/historial">‹ Historial</a>
    <div class="panel resumen" style="padding:6px 14px">
      <div><span>Al empezar${p.inicio ? " (" + esc(fechaHora(p.inicio.cuando)) + ")" : ""}</span><strong>${p.inicio ? eur(p.inicio.importe) : "—"}</strong></div>
      <div><span>Entradas</span><strong class="cero">${eurSigno(entradas)}</strong></div>
      <div><span>Salidas</span><strong class="neg">${eurSigno(salidas)}</strong></div>
      <div><span>${p.fin ? "Debería haber al contar" : "Debería haber ahora"}</span><strong>${finEsperado === null ? "—" : eur(finEsperado)}</strong></div>
      ${p.fin ? `<div><span>Contado (${esc(fechaHora(p.fin.cuando))})</span><strong>${eur(p.fin.importe)}</strong></div>
                 <div><span>Resultado</span><strong class="${p.fin.diferencia === null ? "" : claseDescuadre(p.fin.diferencia)}">${p.fin.diferencia === null ? "Primer recuento" : textoDescuadre(p.fin.diferencia)}</strong></div>` : ""}
    </div>
    <div class="panel">
      <h2>Movimientos</h2>
      ${p.inicio ? filaEvento(p.inicio) : ""}
      ${p.eventos.length ? p.eventos.map((e) => filaEvento(e)).join("") : '<p class="suave">No hubo movimientos en este tramo.</p>'}
      ${p.fin ? filaEvento(p.fin) : ""}
    </div>`;
  activarAnular(cont, () => pintarPeriodo(cont, clave));
}

// =============================================================
// CALENDARIO POR DÍAS (opción 2)
// =============================================================
async function pintarCalendario(cont, mesParam) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const r = await cargarLinea();
  const mes = /^\d{4}-\d{2}$/.test(mesParam || "") ? mesParam : iso(new Date()).slice(0, 7);
  const [y, m] = mes.split("-").map(Number);
  const primero = new Date(y, m - 1, 1);
  const diasMes = new Date(y, m, 0).getDate();
  const hueco = (primero.getDay() + 6) % 7; // lunes = 0
  const mesAnt = iso(new Date(y, m - 2, 1)).slice(0, 7);
  const mesSig = iso(new Date(y, m, 1)).slice(0, 7);
  const nombreMes = primero.toLocaleDateString("es-ES", { month: "long", year: "numeric" });

  const porDia = {};
  r.eventos.forEach((e) => {
    const d = diaDe(e.cuando);
    if (!d.startsWith(mes)) return;
    const x = (porDia[d] ||= { neto: 0, n: 0, recuento: false });
    if (e.tipo === "recuento") x.recuento = true;
    else if (!e.anulado) { x.neto += e.importe; x.n++; }
  });

  let celdas = DIAS_SEMANA.map((d) => `<div class="cab">${d}</div>`).join("");
  for (let i = 0; i < hueco; i++) celdas += '<span class="vacio"></span>';
  const hoyIso = iso(new Date());
  for (let dnum = 1; dnum <= diasMes; dnum++) {
    const d = `${mes}-${String(dnum).padStart(2, "0")}`;
    const x = porDia[d];
    celdas += `
      <a href="#/cajaroja/dia/${d}" class="${x ? "" : "sin"} ${d === hoyIso ? "hoy" : ""}">
        ${dnum}
        ${x && x.n ? `<small class="${x.neto < 0 ? "neg" : "cero"}">${eurCorto(x.neto)}</small>` : ""}
        ${x && x.recuento ? '<span class="r" aria-label="recuento"></span>' : ""}
      </a>`;
  }

  // Resumen del mes
  const delMes = r.eventos.filter((e) => diaDe(e.cuando).startsWith(mes) && e.tipo !== "recuento" && !e.anulado);
  const ent = delMes.filter((e) => e.importe > 0).reduce((s, e) => s + e.importe, 0);
  const sal = delMes.filter((e) => e.importe < 0).reduce((s, e) => s + e.importe, 0);

  cont.innerHTML = `
    <div class="panel">
      <div class="mes-nav">
        <a href="#/cajaroja/calendario/${mesAnt}" aria-label="Mes anterior">‹</a>
        <strong>${esc(nombreMes.charAt(0).toUpperCase() + nombreMes.slice(1))}</strong>
        <a href="#/cajaroja/calendario/${mesSig}" aria-label="Mes siguiente">›</a>
      </div>
      <div class="cal">${celdas}</div>
      <small class="nota">Debajo de cada día, lo que entró o salió en euros. El punto rosa marca los días con recuento. Pulsa un día para ver el detalle.</small>
    </div>
    <div class="panel resumen" style="padding:6px 14px">
      <div><span>Entradas del mes</span><strong class="cero">${eurSigno(ent)}</strong></div>
      <div><span>Salidas del mes</span><strong class="neg">${eurSigno(sal)}</strong></div>
    </div>`;
}

async function pintarDia(cont, dia) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia || "")) { location.hash = "#/cajaroja/calendario"; return; }
  const r = await cargarLinea();
  const delDia = r.eventos.filter((e) => diaDe(e.cuando) === dia);
  // Saldo al empezar el día: el del último movimiento anterior
  const previos = r.eventos.filter((e) => diaDe(e.cuando) < dia);
  const ultimoPrevio = previos[previos.length - 1];
  const saldoDe = (e) => (e.tipo === "recuento" ? e.importe : e.despues);
  const saldoInicio = ultimoPrevio ? saldoDe(ultimoPrevio) : null;
  const ultimoDelDia = delDia[delDia.length - 1];
  const saldoFin = ultimoDelDia ? saldoDe(ultimoDelDia) : saldoInicio;
  const fechaLargaDia = new Date(dia + "T12:00:00").toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  cont.innerHTML = `
    <a class="volver" href="#/cajaroja/calendario/${dia.slice(0, 7)}">‹ Calendario</a>
    <div class="panel">
      <h2>${esc(fechaLargaDia.charAt(0).toUpperCase() + fechaLargaDia.slice(1))}</h2>
      <div class="resumen">
        <div><span>Al empezar el día</span><strong>${saldoInicio === null ? "—" : eur(saldoInicio)}</strong></div>
        <div><span>Al terminar el día</span><strong>${saldoFin === null ? "—" : eur(saldoFin)}</strong></div>
      </div>
    </div>
    <div class="panel">
      <h2>Movimientos</h2>
      ${delDia.length ? delDia.map((e) => filaEvento(e, false)).join("") : '<p class="suave" style="margin:0">Este día no hubo movimientos.</p>'}
    </div>`;
  activarAnular(cont, () => pintarDia(cont, dia));
}
