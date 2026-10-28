// =============================================================
// MÓDULO CAJA: cierre diario, historial por semanas, detalle y correcciones.
// =============================================================
import {
  db, estado, BILLETES, ICONOS, $, esc, eur, eurSigno, etiquetaBillete, leerEur, leerEntero,
  fechaCajaHoy, fechaLarga, lunesDe, horaDe, horaCorta, ms, mostrar, traducirError,
  calcular, fondoDe, vigentes, htmlResumen, textoDescuadre, claseDescuadre, claseEstado
} from "./nucleo.js?v=2";
import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, query, where, orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const CAMPOS = {
  ticketEfectivo: "Efectivo del ticket",
  ticketTarjeta: "Tarjeta del ticket",
  totalRecuento: "Total contado",
  totalGastos: "Total gastos",
  nota: "Nota"
};

export const moduloCaja = {
  id: "caja",
  titulo: "Caja",
  icono: ICONOS.caja,
  enBarra: true,
  roles: ["socio", "encargado", "equipo"],
  pestanas: [
    { id: "cierre", titulo: "Cierre de hoy" },
    { id: "historial", titulo: "Historial", roles: ["socio"] },
    { id: "detalle", oculta: true, padre: "historial", roles: ["socio"] }
  ],
  render: renderCaja,
  inicio: tarjetaInicio
};

let formulario = null;   // se crea una vez y se conserva al cambiar de pantalla
let cacheCierres = [];
let cacheCorr = {};

function renderCaja({ sub, resto, cont }) {
  if (sub === "historial") return pintarHistorial(cont);
  if (sub === "detalle") return pintarDetalle(cont, resto[0]);
  return mostrarFormulario(cont);
}

// =============================================================
// TARJETA PARA LA PANTALLA DE INICIO
// =============================================================
async function tarjetaInicio(cont) {
  const fecha = fechaCajaHoy();
  let hecho;          // objeto = hecho, null = no hecho, undefined = no se sabe (sin permiso)
  try {
    const s = await getDoc(doc(db, "cierres", fecha));
    hecho = s.exists() ? s.data() : null;
  } catch (e) {
    hecho = undefined;
  }

  let html = "";
  if (hecho) {
    const r = calcular(hecho, fondoDe(hecho));
    html += `
      <div class="panel">
        <h2>Cierre de hoy</h2>
        <p style="margin:0">Hecho por ${esc(hecho.autorNombre)} a las ${esc(horaCorta(hecho.creadoEn))}.</p>
        <div class="estado ${claseEstado(r.descuadre)}">${textoDescuadre(r.descuadre)}</div>
      </div>`;
  } else {
    html += `
      <div class="panel">
        <h2>Cierre de hoy</h2>
        <p class="suave" style="margin:0">${hecho === null ? "Todavía no se ha hecho." : "Hazlo al terminar la noche."}</p>
        <a class="boton" href="#/caja/cierre">Hacer el cierre</a>
      </div>`;
  }

  if (estado.usuario.socio) {
    const lunes = lunesDe(fecha);
    const [sc, sk] = await Promise.all([
      getDocs(query(collection(db, "cierres"), where("fecha", ">=", lunes), orderBy("fecha"))),
      getDocs(query(collection(db, "correcciones"), where("fechaCierre", ">=", lunes)))
    ]);
    const corr = agruparCorrecciones(sk);
    const t = { ef: 0, tj: 0, g: 0, d: 0, n: 0 };
    sc.forEach((d) => {
      const v = vigentes(d.data(), corr[d.id]);
      t.ef += v.ticketEfectivo; t.tj += v.ticketTarjeta; t.g += v.totalGastos; t.d += v.descuadre; t.n++;
    });
    html += `
      <div class="panel">
        <h2>Esta semana</h2>
        <div class="metricas">
          <div><small>Vendido</small><strong>${eur(t.ef + t.tj)}</strong></div>
          <div><small>Descuadre</small><strong class="${claseDescuadre(t.d)}">${t.d === 0 ? "0,00 €" : eurSigno(t.d)}</strong></div>
          <div><small>Efectivo</small><strong>${eur(t.ef)}</strong></div>
          <div><small>Tarjeta</small><strong>${eur(t.tj)}</strong></div>
          <div><small>Gastos de caja</small><strong>${eur(t.g)}</strong></div>
          <div><small>Días cerrados</small><strong>${t.n}</strong></div>
        </div>
        <a class="boton sec" href="#/caja/historial">Ver historial</a>
      </div>`;
  }
  cont.innerHTML = html;
}

function agruparCorrecciones(snap) {
  const m = {};
  snap.forEach((d) => {
    const c = { id: d.id, ...d.data() };
    (m[c.cierreId] ||= []).push(c);
  });
  Object.values(m).forEach((l) => l.sort((a, b) => ms(a.creadoEn) - ms(b.creadoEn)));
  return m;
}

// =============================================================
// FORMULARIO DE CIERRE
// =============================================================
function crearFormulario() {
  const f = document.createElement("div");
  f.innerHTML = `
    <div class="panel">
      <h2>Cierre de caja</h2>
      <label for="cFecha">Día de la caja (el día que se abre)</label>
      <input id="cFecha" type="date">
      <small class="nota" id="cHora"></small>
      <div id="cAviso"></div>
    </div>

    <div class="panel">
      <h2>Ticket de cierre de la registradora</h2>
      <div class="fila">
        <div><label for="cEfectivo">Efectivo (€)</label><input id="cEfectivo" inputmode="decimal" placeholder="0,00"></div>
        <div><label for="cTarjeta">Tarjeta (€)</label><input id="cTarjeta" inputmode="decimal" placeholder="0,00"></div>
      </div>
      <div class="resumen" style="margin-top:10px"><div><span>Total vendido</span><strong id="cTotalTicket">0,00 €</strong></div></div>
    </div>

    <div class="panel">
      <h2>Recuento del cajón</h2>
      <div class="recuento cabecera"><span style="text-align:right">Valor</span><span>Cantidad</span><span style="text-align:right">Total</span></div>
      ${BILLETES.map((b) => `
        <div class="recuento">
          <span class="valor">${etiquetaBillete(b)}</span>
          <input inputmode="numeric" data-billete="${b}" placeholder="0" aria-label="Cantidad de ${etiquetaBillete(b)}">
          <span class="linea" id="l${b}">0,00 €</span>
        </div>`).join("")}
      <div class="resumen"><div><span>Total contado</span><strong id="cTotalContado">0,00 €</strong></div></div>
    </div>

    <div class="panel">
      <h2>Gastos pagados con la caja</h2>
      <div class="chips" id="cChips"></div>
      <div id="cGastos"></div>
      <datalist id="cPersonas"></datalist>
      <button class="sec" id="bOtroGasto" type="button">Añadir otro gasto</button>
      <div class="resumen" style="margin-top:10px"><div><span>Total gastos</span><strong id="cTotalGastos">0,00 €</strong></div></div>
    </div>

    <div class="panel">
      <h2>Resultado</h2>
      <div class="resumen" id="cResumen"></div>
      <div id="cEstado" class="estado neutro"></div>
      <label for="cObs">Observaciones (opcional)</label>
      <textarea id="cObs" placeholder="Se rompió una botella, invitación a…"></textarea>
      <label class="check" id="cPruebaCaja"><input type="checkbox" id="cPrueba"> Cierre de prueba: no cuenta y no sale en el historial</label>
      <button id="bGuardar" type="button">Guardar cierre</button>
      <small class="nota">Una vez guardado, el cierre no se puede modificar ni borrar. Si hay un error, un socio lo corrige desde el historial y la corrección queda registrada.</small>
    </div>`;

  const q = (sel) => f.querySelector(sel);
  q("#cChips").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-concepto]");
    if (b) anadirGasto(b.dataset.concepto);
  });
  q("#bOtroGasto").addEventListener("click", () => anadirGasto(""));
  q("#cGastos").addEventListener("click", (e) => {
    if (e.target.classList.contains("gQuitar")) {
      e.target.closest(".gasto").remove();
      recalcular();
    }
  });
  f.addEventListener("input", recalcular);
  q("#cFecha").addEventListener("change", comprobarExistente);
  q("#bGuardar").addEventListener("click", guardarCierre);

  // Reloj: muestra la hora a la que se registrará el cierre
  setInterval(actualizarHora, 20000);
  return f;
}

function mostrarFormulario(cont) {
  if (!formulario) formulario = crearFormulario();
  cont.innerHTML = "";
  cont.appendChild(formulario);

  const socio = estado.usuario.socio;
  $("cChips").innerHTML = estado.ajustes.gastosRapidos
    .map((g) => `<button type="button" data-concepto="${esc(g)}">+ ${esc(g)}</button>`).join("");
  $("cPersonas").innerHTML = (estado.ajustes.personas || [])
    .map((p) => `<option value="${esc(p)}"></option>`).join("");
  if (!$("cFecha").value || !socio) $("cFecha").value = fechaCajaHoy();
  $("cFecha").readOnly = !socio;
  $("cPruebaCaja").classList.toggle("oculto", !socio);
  if (!socio) $("cPrueba").checked = false;
  actualizarHora();
  recalcular();
  comprobarExistente();
}

function actualizarHora() {
  const el = document.getElementById("cHora");
  if (!el) return;
  const ahora = new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  el.textContent = `La hora del cierre se registra sola al guardar. Ahora son las ${ahora}.`;
}

function anadirGasto(concepto = "") {
  const div = document.createElement("div");
  div.className = "gasto";
  div.innerHTML = `
    <input class="gConcepto" placeholder="Concepto" value="${esc(concepto)}">
    <input class="gImporte" inputmode="decimal" placeholder="Importe €">
    <input class="gPersona" placeholder="Persona (opcional)" list="cPersonas">
    <button type="button" class="gQuitar">Quitar</button>`;
  $("cGastos").appendChild(div);
  div.querySelector(concepto ? ".gImporte" : ".gConcepto").focus();
  recalcular();
}

function leerFormulario() {
  const ticketEfectivo = leerEur($("cEfectivo").value);
  const ticketTarjeta = leerEur($("cTarjeta").value);
  const recuento = {};
  let totalRecuento = 0;
  formulario.querySelectorAll("input[data-billete]").forEach((i) => {
    const b = Number(i.dataset.billete);
    const n = leerEntero(i.value);
    recuento[b] = n;
    totalRecuento += n * b;
  });
  const gastos = [];
  let totalGastos = 0;
  let gastoMal = false;
  formulario.querySelectorAll("#cGastos .gasto").forEach((g) => {
    const concepto = g.querySelector(".gConcepto").value.trim();
    const persona = g.querySelector(".gPersona").value.trim();
    const importe = leerEur(g.querySelector(".gImporte").value);
    if (!concepto && importe === null && !persona) return; // fila vacía: se ignora
    if (!concepto || importe === null || isNaN(importe) || importe <= 0) { gastoMal = true; return; }
    gastos.push({ concepto, persona, importe });
    totalGastos += importe;
  });
  const hayDatos = $("cEfectivo").value.trim() !== "" || $("cTarjeta").value.trim() !== "" || totalRecuento > 0 || gastos.length > 0;
  return { ticketEfectivo, ticketTarjeta, recuento, totalRecuento, gastos, totalGastos, gastoMal, hayDatos };
}

function recalcular() {
  if (!formulario) return;
  const f = leerFormulario();
  const fondo = estado.ajustes.fondoCambio;
  formulario.querySelectorAll("input[data-billete]").forEach((i) => {
    const b = Number(i.dataset.billete);
    $("l" + b).textContent = eur(leerEntero(i.value) * b);
  });
  const r = calcular({
    ticketEfectivo: Number.isFinite(f.ticketEfectivo) ? f.ticketEfectivo : 0,
    ticketTarjeta: Number.isFinite(f.ticketTarjeta) ? f.ticketTarjeta : 0,
    totalRecuento: f.totalRecuento,
    totalGastos: f.totalGastos
  }, fondo);
  $("cTotalTicket").textContent = eur(r.ticketTotal);
  $("cTotalContado").textContent = eur(r.totalRecuento);
  $("cTotalGastos").textContent = eur(r.totalGastos);

  if (!f.hayDatos) {
    $("cResumen").innerHTML = `<div><span>Fondo de cambio</span><strong>${eur(fondo)}</strong></div>`;
    $("cEstado").className = "estado neutro";
    $("cEstado").textContent = "Rellena el ticket y el recuento para ver si cuadra";
    return;
  }
  $("cResumen").innerHTML = htmlResumen(r);
  $("cEstado").className = "estado " + claseEstado(r.descuadre);
  $("cEstado").textContent = textoDescuadre(r.descuadre);
}

function limpiarFormulario() {
  if (!formulario) return;
  formulario.querySelectorAll("input:not([type=checkbox]), textarea").forEach((i) => (i.value = ""));
  $("cGastos").innerHTML = "";
  $("cPrueba").checked = false;
  $("cFecha").value = fechaCajaHoy();
  $("cAviso").innerHTML = "";
  recalcular();
}

async function comprobarExistente() {
  const fecha = $("cFecha").value;
  $("cAviso").innerHTML = "";
  if (!fecha) return;
  try {
    const s = await getDoc(doc(db, "cierres", fecha));
    if (s.exists()) {
      const c = s.data();
      $("cAviso").innerHTML = `<div class="estado sobra" style="font-weight:400">Ya hay un cierre guardado para este día, hecho por ${esc(c.autorNombre)} a las ${esc(horaCorta(c.creadoEn))}.</div>`;
    }
  } catch (e) {
    // Sin permiso para verlo: puede que exista o no. Se comprobará al guardar.
  }
}

async function guardarCierre() {
  const u = estado.usuario;
  const fecha = $("cFecha").value;
  const f = leerFormulario();
  const prueba = u.socio && $("cPrueba").checked;
  const fondo = estado.ajustes.fondoCambio;

  if (!fecha) return mostrar("Falta el día de la caja.", "mal");
  if (f.ticketEfectivo === null || f.ticketTarjeta === null) return mostrar("Rellena el efectivo y la tarjeta del ticket de cierre. Si no hay, pon 0.", "mal");
  if (isNaN(f.ticketEfectivo) || isNaN(f.ticketTarjeta)) return mostrar("Revisa los importes del ticket: solo números, con coma para los céntimos.", "mal");
  if (f.gastoMal) return mostrar("Revisa los gastos: cada uno necesita concepto e importe.", "mal");
  if (f.totalRecuento === 0 && !confirm("No has contado ningún billete ni moneda. ¿Seguir de todas formas?")) return;

  const r = calcular(f, fondo);
  const pregunta = (prueba ? "CIERRE DE PRUEBA\n\n" : "") +
    "¿Guardar el cierre del " + fechaLarga(fecha).toLowerCase() + "?\n\n" +
    "Resultado: " + textoDescuadre(r.descuadre) + "\n\n" +
    "Una vez guardado no se puede modificar.";
  if (!confirm(pregunta)) return;

  const datos = {
    fecha,
    ticketEfectivo: r.ticketEfectivo,
    ticketTarjeta: r.ticketTarjeta,
    ticketTotal: r.ticketTotal,
    recuento: f.recuento,
    totalRecuento: r.totalRecuento,
    fondo,
    gastos: f.gastos,
    totalGastos: r.totalGastos,
    deberiaHaber: r.deberiaHaber,
    descuadre: r.descuadre,
    aRetirar: r.aRetirar,
    observaciones: $("cObs").value.trim(),
    autorUid: u.uid,
    autorNombre: u.nombre,
    creadoEn: serverTimestamp(),
    version: 2
  };

  $("bGuardar").disabled = true;
  try {
    let ref;
    if (prueba) {
      ref = await addDoc(collection(db, "pruebas"), datos);
    } else {
      ref = doc(db, "cierres", fecha);
      if (u.socio && (await getDoc(ref)).exists()) {
        return mostrar("Ya existe un cierre para ese día. Si hay que cambiar algo, hazlo con una corrección desde el historial.", "mal");
      }
      await setDoc(ref, datos);
    }
    // Leemos la hora real que ha puesto el servidor
    let hora = horaCorta(new Date());
    try {
      const s = await getDoc(ref);
      if (s.exists()) hora = horaCorta(s.data().creadoEn);
    } catch (e) { /* nos quedamos con la hora del móvil */ }

    const cont = $("contenido");
    limpiarFormulario();
    cont.innerHTML = `
      <div class="panel">
        <h2>${prueba ? "Cierre de prueba guardado" : "Cierre guardado"}</h2>
        <p class="suave" style="margin-top:0">${esc(fechaLarga(fecha))}. Cerrado a las ${esc(hora)} por ${esc(u.nombre)}.</p>
        <div class="resumen">
          <div><span>Efectivo del ticket</span><strong>${eur(r.ticketEfectivo)}</strong></div>
          <div><span>Tarjeta del ticket</span><strong>${eur(r.ticketTarjeta)}</strong></div>
          <div><span>Total vendido</span><strong>${eur(r.ticketTotal)}</strong></div>
          ${htmlResumen(r)}
        </div>
        <div class="estado ${claseEstado(r.descuadre)}">${textoDescuadre(r.descuadre)}</div>
        <a class="boton sec" href="#/inicio">Volver al inicio</a>
      </div>`;
    window.scrollTo(0, 0);
  } catch (e) {
    if (e.code === "permission-denied") {
      mostrar("No se ha podido guardar: ya existe un cierre para ese día o no tienes permiso.", "mal");
    } else {
      mostrar("Error al guardar: " + e.message, "mal");
    }
  } finally {
    $("bGuardar").disabled = false;
  }
}

// =============================================================
// HISTORIAL (solo socios)
// =============================================================
async function cargarDatosHistorial() {
  const [sc, sk] = await Promise.all([
    getDocs(query(collection(db, "cierres"), orderBy("fecha", "desc"), limit(120))),
    getDocs(collection(db, "correcciones"))
  ]);
  cacheCorr = agruparCorrecciones(sk);
  cacheCierres = [];
  sc.forEach((d) => cacheCierres.push({ id: d.id, ...d.data() }));
}

async function pintarHistorial(cont) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  await cargarDatosHistorial();
  if (!cacheCierres.length) {
    cont.innerHTML = '<div class="panel">Todavía no hay cierres guardados. El primero aparecerá aquí en cuanto se haga.</div>';
    return;
  }
  const semanas = {};
  cacheCierres.forEach((c) => { (semanas[lunesDe(c.fecha)] ||= []).push(c); });
  let html = "";
  Object.keys(semanas).sort().reverse().forEach((lunes) => {
    const t = { ef: 0, tj: 0, g: 0, d: 0 };
    const items = semanas[lunes].map((c) => {
      const v = vigentes(c, cacheCorr[c.id]);
      t.ef += v.ticketEfectivo; t.tj += v.ticketTarjeta; t.g += v.totalGastos; t.d += v.descuadre;
      const corregido = (cacheCorr[c.id] || []).length > 0;
      return `
        <a class="item" href="#/caja/detalle/${encodeURIComponent(c.id)}">
          <div class="top"><span>${esc(fechaLarga(c.fecha))}${corregido ? '<span class="etiqueta">corregido</span>' : ""}</span><span>${eur(v.ticketTotal)}</span></div>
          <div class="sub"><span>${esc(c.autorNombre)} a las ${esc(horaCorta(c.creadoEn))}</span><span class="${claseDescuadre(v.descuadre)}">${textoDescuadre(v.descuadre)}</span></div>
        </a>`;
    }).join("");
    html += `
      <div class="semana">
        <h3>Semana del ${esc(fechaLarga(lunes).toLowerCase())}</h3>
        <div class="panel resumen" style="padding:6px 14px">
          <div><span>Efectivo</span><strong>${eur(t.ef)}</strong></div>
          <div><span>Tarjeta</span><strong>${eur(t.tj)}</strong></div>
          <div><span>Total vendido</span><strong>${eur(t.ef + t.tj)}</strong></div>
          <div><span>Gastos de caja</span><strong>${eur(t.g)}</strong></div>
          <div><span>Descuadre de la semana</span><strong class="${claseDescuadre(t.d)}">${t.d === 0 ? "0,00 €" : eurSigno(t.d)}</strong></div>
        </div>
        ${items}
      </div>`;
  });
  cont.innerHTML = html;
}

// =============================================================
// DETALLE Y CORRECCIONES (solo socios)
// =============================================================
async function pintarDetalle(cont, id) {
  if (!id) { cont.innerHTML = ""; location.hash = "#/caja/historial"; return; }
  let c = cacheCierres.find((x) => x.id === id);
  if (!c) {
    await cargarDatosHistorial();
    c = cacheCierres.find((x) => x.id === id);
  }
  if (!c) { cont.innerHTML = '<div class="panel">No se ha encontrado ese cierre.</div>'; return; }

  const corrs = cacheCorr[id] || [];
  const original = calcular(c, fondoDe(c));
  const filasRecuento = BILLETES
    .filter((b) => (c.recuento?.[b] || 0) > 0)
    .map((b) => `<div><span>${c.recuento[b]} × ${etiquetaBillete(b)}</span><strong>${eur(c.recuento[b] * b)}</strong></div>`)
    .join("") || "<div><span>Sin recuento</span></div>";
  const filasGastos = (c.gastos || [])
    .map((g) => `<div><span>${esc(g.concepto)}${g.persona ? " (" + esc(g.persona) + ")" : ""}</span><strong>${eur(g.importe)}</strong></div>`)
    .join("") || "<div><span>Sin gastos</span></div>";

  let html = `
    <a class="volver" href="#/caja/historial">‹ Historial</a>
    <div class="panel">
      <h2>${esc(fechaLarga(c.fecha))}</h2>
      <p class="suave" style="margin:0">Cerrado por ${esc(c.autorNombre)} el ${esc(horaDe(c.creadoEn))}</p>
    </div>
    <div class="panel"><h2>Ticket de cierre</h2><div class="resumen">
      <div><span>Efectivo</span><strong>${eur(c.ticketEfectivo)}</strong></div>
      <div><span>Tarjeta</span><strong>${eur(c.ticketTarjeta)}</strong></div>
      <div><span>Total</span><strong>${eur(c.ticketTotal)}</strong></div>
    </div></div>
    <div class="panel"><h2>Recuento</h2><div class="resumen">${filasRecuento}
      <div><span>Total contado</span><strong>${eur(c.totalRecuento)}</strong></div>
    </div></div>
    <div class="panel"><h2>Gastos</h2><div class="resumen">${filasGastos}
      <div><span>Total gastos</span><strong>${eur(c.totalGastos)}</strong></div>
    </div></div>
    <div class="panel"><h2>Resultado original</h2>
      <div class="resumen">${htmlResumen(original)}</div>
      <div class="estado ${claseEstado(original.descuadre)}">${textoDescuadre(original.descuadre)}</div>
      ${c.observaciones ? `<p style="margin-bottom:0"><strong>Observaciones:</strong> ${esc(c.observaciones)}</p>` : ""}
    </div>`;

  if (corrs.length) {
    const v = vigentes(c, corrs);
    html += `
      <div class="panel"><h2>Correcciones</h2>
        ${corrs.map((k) => `
          <div class="item">
            <div class="top"><span>${esc(CAMPOS[k.campo] || k.campo)}</span><span>${k.campo === "nota" ? "" : eur(k.valorAnterior) + " a " + eur(k.valorNuevo)}</span></div>
            <div class="sub"><span>${esc(k.autorNombre)}, ${esc(horaDe(k.creadoEn))}</span></div>
            <p style="margin:6px 0 0">${esc(k.motivo)}</p>
          </div>`).join("")}
      </div>
      <div class="panel"><h2>Resultado con correcciones</h2>
        <div class="resumen">${htmlResumen(v)}</div>
        <div class="estado ${claseEstado(v.descuadre)}">${textoDescuadre(v.descuadre)}</div>
      </div>`;
  }

  html += `
    <div class="panel">
      <h2>Añadir corrección</h2>
      <label for="dCampo">¿Qué hay que corregir?</label>
      <select id="dCampo">
        <option value="ticketEfectivo">Efectivo del ticket</option>
        <option value="ticketTarjeta">Tarjeta del ticket</option>
        <option value="totalRecuento">Total contado</option>
        <option value="totalGastos">Total gastos</option>
        <option value="nota">Solo una nota (sin cambiar importes)</option>
      </select>
      <div id="dValorCaja">
        <small class="nota" id="dActual"></small>
        <label for="dValor">Valor correcto (€)</label>
        <input id="dValor" inputmode="decimal" placeholder="0,00">
      </div>
      <label for="dMotivo">Motivo</label>
      <textarea id="dMotivo" placeholder="El ticket de cierre decía 812,50 y se apuntó 821,50"></textarea>
      <button id="bCorregir" type="button">Guardar corrección</button>
    </div>`;
  cont.innerHTML = html;

  const actualizarCampo = () => {
    const campo = $("dCampo").value;
    const esNota = campo === "nota";
    $("dValorCaja").classList.toggle("oculto", esNota);
    $("dActual").textContent = esNota ? "" : "Valor actual: " + eur(vigentes(c, cacheCorr[id])[campo]);
  };
  $("dCampo").addEventListener("change", actualizarCampo);
  actualizarCampo();

  $("bCorregir").addEventListener("click", async () => {
    const campo = $("dCampo").value;
    const motivo = $("dMotivo").value.trim();
    if (!motivo) return mostrar("Escribe el motivo de la corrección.", "mal");
    const datos = {
      cierreId: c.id,
      fechaCierre: c.fecha,
      campo,
      motivo,
      autorUid: estado.usuario.uid,
      autorNombre: estado.usuario.nombre,
      creadoEn: serverTimestamp()
    };
    if (campo !== "nota") {
      const actual = vigentes(c, cacheCorr[id])[campo];
      const nuevo = leerEur($("dValor").value);
      if (nuevo === null || isNaN(nuevo)) return mostrar("Escribe el valor correcto en euros.", "mal");
      if (nuevo === actual) return mostrar("El valor nuevo es igual al actual.", "mal");
      datos.valorAnterior = actual;
      datos.valorNuevo = nuevo;
    }
    if (!confirm("¿Guardar esta corrección? Quedará registrada con tu nombre y no se puede borrar.")) return;
    $("bCorregir").disabled = true;
    try {
      await addDoc(collection(db, "correcciones"), datos);
      await cargarDatosHistorial();
      await pintarDetalle(cont, id);
      mostrar("Corrección guardada.", "ok");
    } catch (e) {
      mostrar("No se ha podido guardar la corrección: " + traducirError(e.code || e.message), "mal");
      $("bCorregir").disabled = false;
    }
  });
}
