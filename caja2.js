// =============================================================
// MÓDULO CAJA 2: segunda caja registradora, sin ticket de cierre.
// Venta de la noche = contado − fondo de cambio + gastos pagados con la caja.
// Lo retirado (contado − fondo) entra en la caja roja.
// Sus ventas se declaran aparte: se registran todas y se ven en el resumen
// trimestral, pero no suman en la estimación del 303 de Sweet Dreams.
// =============================================================
import {
  db, estado, BILLETES, $, esc, eur, etiquetaBillete, leerEur, leerEntero,
  fechaCajaHoy, fechaLarga, horaDe, horaCorta, mostrar, traducirError, iso
} from "./nucleo.js?v=2";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const FONDO = 16000; // 160 € de cambio

export const moduloCaja2 = {
  id: "caja2",
  titulo: "Caja 2",
  descripcion: "Cierre de la segunda caja (sin ticket): recuento, gastos y lo que va a la caja roja",
  icono: "",
  enBarra: false,
  roles: ["socio", "encargado", "equipo"],
  pestanas: [
    { id: "cierre", titulo: "Cierre" },
    { id: "historial", titulo: "Historial", roles: ["socio"] }
  ],
  render: ({ sub, cont }) => (sub === "historial" ? pintarHistorial(cont) : pintarCierre(cont)),
  inicio: tarjetaInicio
};

// ---------- Utilidades ----------
const fechaCorta = (t) => (t ? t.split("-").reverse().join("/") : "");
const num2 = (c) => (c / 100).toFixed(2).replace(".", ",");
function trimestreDe(fecha) {
  const [y, m] = fecha.split("-").map(Number);
  const t = Math.floor((m - 1) / 3) + 1;
  const mesIni = (t - 1) * 3 + 1;
  return { clave: `${y}-${t}`, nombre: `${t}.º trimestre de ${y}`, desde: `${y}-${String(mesIni).padStart(2, "0")}-01`, hasta: iso(new Date(y, mesIni + 2, 0)) };
}

// =============================================================
// INICIO: aviso si falta el cierre de hoy
// =============================================================
async function tarjetaInicio(cont) {
  const fecha = fechaCajaHoy();
  let hecho;
  try {
    const s = await getDocs(query(collection(db, "cierresCaja2"), where("fecha", "==", fecha)));
    hecho = false;
    s.forEach((d) => { if (!d.data().anulado) hecho = d.data(); });
  } catch (e) {
    hecho = undefined; // sin permiso para comprobarlo
  }
  cont.innerHTML = hecho
    ? `<div class="panel"><h2>Caja 2</h2><p style="margin:0">Cerrada por ${esc(hecho.autorNombre)} a las ${esc(horaCorta(hecho.creadoEn))}: venta ${eur(hecho.venta)}.</p></div>`
    : `<div class="panel"><h2>Caja 2</h2><p class="suave" style="margin:0">${hecho === false ? "Todavía no se ha cerrado hoy." : "Ciérrala al terminar la noche."}</p><a class="boton sec" href="#/caja2/cierre">Cerrar caja 2</a></div>`;
}

// =============================================================
// CIERRE
// =============================================================
async function pintarCierre(cont) {
  const socio = estado.usuario.socio;
  cont.innerHTML = `
    <div class="panel">
      <h2>Cierre de la caja 2</h2>
      <label for="dFecha">Día de la caja (el día que se abre)</label>
      <input id="dFecha" type="date" value="${fechaCajaHoy()}" ${socio ? "" : "readonly"}>
      <small class="nota">Esta caja no tiene ticket: la venta se calcula con lo contado, el cambio de ${eur(FONDO)} y los gastos.</small>
      <div id="dAviso"></div>
    </div>

    <div class="panel">
      <h2>Recuento del cajón</h2>
      <div class="recuento cabecera"><span style="text-align:right">Valor</span><span>Cantidad</span><span style="text-align:right">Total</span></div>
      ${BILLETES.map((b) => `
        <div class="recuento">
          <span class="valor">${etiquetaBillete(b)}</span>
          <input inputmode="numeric" data-billete2="${b}" placeholder="0" aria-label="Cantidad de ${etiquetaBillete(b)}">
          <span class="linea" id="dl${b}">0,00 €</span>
        </div>`).join("")}
      <div class="resumen"><div><span>Total contado</span><strong id="dContado">0,00 €</strong></div></div>
    </div>

    <div class="panel">
      <h2>Gastos pagados con la caja 2</h2>
      <div class="chips" id="dChips">${(estado.ajustes.gastosRapidos || []).map((g) => `<button type="button" data-concepto="${esc(g)}">+ ${esc(g)}</button>`).join("")}</div>
      <div id="dGastos"></div>
      <datalist id="dPersonas">${(estado.ajustes.personas || []).map((p) => `<option value="${esc(p)}"></option>`).join("")}</datalist>
      <button class="sec" id="dOtroGasto" type="button">Añadir otro gasto</button>
      <div class="resumen" style="margin-top:10px"><div><span>Total gastos</span><strong id="dTotalGastos">0,00 €</strong></div></div>
    </div>

    <div class="panel">
      <h2>Resultado</h2>
      <div class="resumen" id="dResumen"></div>
      <div id="dEstado"></div>
      <label for="dObs">Observaciones (opcional)</label>
      <textarea id="dObs" placeholder="Algo que haya que saber de esta noche…"></textarea>
      <button id="dGuardar" type="button">Guardar cierre de la caja 2</button>
      <small class="nota">Una vez guardado no se puede modificar. Si hay un error, un socio lo anula con el motivo y se vuelve a hacer.</small>
    </div>`;

  const raiz = cont;
  const anadirGasto = (concepto = "") => {
    const div = document.createElement("div");
    div.className = "gasto";
    div.innerHTML = `
      <input class="dgConcepto" placeholder="Concepto" value="${esc(concepto)}">
      <input class="dgImporte" inputmode="decimal" placeholder="Importe €">
      <input class="dgPersona" placeholder="Persona (opcional)" list="dPersonas">
      <button type="button" class="dgQuitar">Quitar</button>`;
    $("dGastos").appendChild(div);
    div.querySelector(concepto ? ".dgImporte" : ".dgConcepto").focus();
    recalcular();
  };

  const leer = () => {
    const recuento = {};
    let totalRecuento = 0;
    raiz.querySelectorAll("input[data-billete2]").forEach((i) => {
      const b = Number(i.dataset.billete2), n = leerEntero(i.value);
      recuento[b] = n;
      totalRecuento += n * b;
      $("dl" + b).textContent = eur(n * b);
    });
    const gastos = [];
    let totalGastos = 0, gastoMal = false;
    raiz.querySelectorAll("#dGastos .gasto").forEach((g) => {
      const concepto = g.querySelector(".dgConcepto").value.trim();
      const persona = g.querySelector(".dgPersona").value.trim();
      const importe = leerEur(g.querySelector(".dgImporte").value);
      if (!concepto && importe === null && !persona) return;
      if (!concepto || importe === null || isNaN(importe) || importe <= 0) { gastoMal = true; return; }
      gastos.push({ concepto, persona, importe });
      totalGastos += importe;
    });
    return { recuento, totalRecuento, gastos, totalGastos, gastoMal, venta: totalRecuento - FONDO + totalGastos, aRetirar: totalRecuento - FONDO };
  };

  const recalcular = () => {
    const f = leer();
    $("dContado").textContent = eur(f.totalRecuento);
    $("dTotalGastos").textContent = eur(f.totalGastos);
    if (!f.totalRecuento && !f.gastos.length) {
      $("dResumen").innerHTML = `<div><span>Fondo de cambio</span><strong>${eur(FONDO)}</strong></div>`;
      $("dEstado").innerHTML = "";
      return;
    }
    $("dResumen").innerHTML = `
      <div><span>Contado</span><strong>${eur(f.totalRecuento)}</strong></div>
      <div><span>− Fondo de cambio</span><strong>${eur(FONDO)}</strong></div>
      <div><span>+ Gastos pagados con la caja</span><strong>${eur(f.totalGastos)}</strong></div>
      <div><span>= Venta de la noche</span><strong>${eur(f.venta)}</strong></div>
      <div><span>A llevar a la caja roja (dejando ${eur(FONDO)})</span><strong>${eur(f.aRetirar)}</strong></div>`;
    $("dEstado").innerHTML = f.aRetirar < 0
      ? `<div class="estado mal" style="font-weight:400">Hay menos de ${eur(FONDO)} en el cajón: falta cambio para mañana.</div>`
      : "";
  };

  const comprobarExistente = async () => {
    $("dAviso").innerHTML = "";
    if (!socio) return;
    try {
      const s = await getDocs(query(collection(db, "cierresCaja2"), where("fecha", "==", $("dFecha").value)));
      s.forEach((d) => {
        const c = d.data();
        if (!c.anulado) $("dAviso").innerHTML = `<div class="estado sobra" style="font-weight:400">Ya hay un cierre de la caja 2 para este día, hecho por ${esc(c.autorNombre)} a las ${esc(horaCorta(c.creadoEn))}.</div>`;
      });
    } catch (e) { /* sin permiso */ }
  };

  $("dChips").addEventListener("click", (e) => { const b = e.target.closest("button[data-concepto]"); if (b) anadirGasto(b.dataset.concepto); });
  $("dOtroGasto").addEventListener("click", () => anadirGasto(""));
  $("dGastos").addEventListener("click", (e) => { if (e.target.classList.contains("dgQuitar")) { e.target.closest(".gasto").remove(); recalcular(); } });
  raiz.addEventListener("input", recalcular);
  $("dFecha").addEventListener("change", comprobarExistente);
  recalcular();
  comprobarExistente();

  $("dGuardar").addEventListener("click", async () => {
    const u = estado.usuario;
    const fecha = $("dFecha").value;
    const f = leer();
    if (!fecha) return mostrar("Falta el día de la caja.", "mal");
    if (f.gastoMal) return mostrar("Revisa los gastos: cada uno necesita concepto e importe.", "mal");
    if (f.totalRecuento === 0 && !confirm("No has contado ningún billete ni moneda. ¿Seguir de todas formas?")) return;
    if (socio) {
      try {
        const s = await getDocs(query(collection(db, "cierresCaja2"), where("fecha", "==", fecha)));
        let repetido = false;
        s.forEach((d) => { if (!d.data().anulado) repetido = true; });
        if (repetido) return mostrar("Ya hay un cierre de la caja 2 para ese día. Si está mal, anúlalo en Historial y vuelve a hacerlo.", "mal");
      } catch (e) { /* seguimos */ }
    }
    if (!confirm(`¿Guardar el cierre de la caja 2 del ${fechaLarga(fecha).toLowerCase()}?\n\nVenta: ${eur(f.venta)}\nA la caja roja: ${eur(f.aRetirar)}\n\nUna vez guardado no se puede modificar.`)) return;
    $("dGuardar").disabled = true;
    try {
      await setDoc(doc(collection(db, "cierresCaja2")), {
        fecha, fondo: FONDO, recuento: f.recuento, totalRecuento: f.totalRecuento,
        gastos: f.gastos, totalGastos: f.totalGastos, venta: f.venta, aRetirar: f.aRetirar,
        observaciones: $("dObs").value.trim(), anulado: false,
        autorUid: u.uid, autorNombre: u.nombre, creadoEn: serverTimestamp()
      });
      cont.innerHTML = `
        <div class="panel">
          <h2>Caja 2 cerrada</h2>
          <div class="resumen">
            <div><span>Día</span><strong>${esc(fechaCorta(fecha))}</strong></div>
            <div><span>Venta de la noche</span><strong>${eur(f.venta)}</strong></div>
            <div><span>A la caja roja</span><strong>${eur(f.aRetirar)}</strong></div>
            <div><span>Se dejan de cambio</span><strong>${eur(FONDO)}</strong></div>
          </div>
          <a class="boton sec" href="#/inicio">Volver al inicio</a>
        </div>`;
      window.scrollTo(0, 0);
    } catch (e) {
      mostrar("No se ha podido guardar: " + traducirError(e.code || e.message), "mal");
      $("dGuardar").disabled = false;
    }
  });
}

// =============================================================
// HISTORIAL (socios)
// =============================================================
async function pintarHistorial(cont) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const [s, sa] = await Promise.all([
    getDocs(collection(db, "cierresCaja2")),
    getDoc(doc(db, "ajustes", "caja2"))
  ]);
  const lista = [];
  s.forEach((d) => lista.push({ id: d.id, ...d.data() }));
  lista.sort((a, b) => b.fecha.localeCompare(a.fecha));
  const declaradaPor = (sa.exists() && sa.data().declaradaPor) || "";
  const T = trimestreDe(iso(new Date()));
  const delTrim = lista.filter((c) => !c.anulado && c.fecha >= T.desde && c.fecha <= T.hasta);
  const mes = iso(new Date()).slice(0, 7);
  const delMes = lista.filter((c) => !c.anulado && c.fecha.startsWith(mes));
  const suma = (l, k) => l.reduce((t, c) => t + (c[k] || 0), 0);

  cont.innerHTML = `
    <div class="panel">
      <h2>Dónde se declara</h2>
      <p class="suave" style="margin-top:0;line-height:1.5">Las ventas de la caja 2 no suman en el 303 de Sweet Dreams porque se declaran aparte. Escribe dónde, para que quede constancia en el resumen trimestral que va a la gestoría.</p>
      <input id="hDeclara" value="${esc(declaradaPor)}" placeholder="Quién y cómo se declara">
      <button class="sec" id="hGuardarDeclara" type="button">Guardar</button>
      ${declaradaPor ? "" : '<div class="estado mal" style="font-weight:400">Falta indicar dónde se declara.</div>'}
    </div>

    <div class="panel">
      <div class="metricas">
        <div><small>Ventas este mes</small><strong>${eur(suma(delMes, "venta"))}</strong></div>
        <div><small>Ventas ${esc(T.nombre)}</small><strong>${eur(suma(delTrim, "venta"))}</strong></div>
        <div><small>A la caja roja este mes</small><strong>${eur(suma(delMes, "aRetirar"))}</strong></div>
        <div><small>Días cerrados este mes</small><strong>${delMes.length}</strong></div>
      </div>
      <button id="hCompartir" type="button">Compartir el trimestre en Excel</button>
    </div>

    <div class="semana"><h3>Cierres</h3>
      ${lista.length ? lista.slice(0, 90).map((c) => `
        <div class="item" style="${c.anulado ? "opacity:.5" : ""}">
          <div class="top"><span>${esc(fechaLarga(c.fecha))}${c.anulado ? '<span class="badge" style="background:var(--rojoF);margin-left:6px;font-size:.75rem;padding:2px 8px;border-radius:20px">anulado</span>' : ""}</span><span>${eur(c.venta)}</span></div>
          <div class="sub"><span>${esc(c.autorNombre)}, ${esc(horaDe(c.creadoEn))} · contado ${eur(c.totalRecuento)}${c.totalGastos ? " · gastos " + eur(c.totalGastos) : ""} · a caja roja ${eur(c.aRetirar)}</span>
            ${c.anulado ? "" : `<button class="sec hAnular" data-id="${esc(c.id)}" type="button" style="width:auto;margin:0;padding:4px 10px;font-size:.8rem">Anular</button>`}</div>
          ${c.anulado ? `<div class="sub"><span>Anulado por ${esc(c.anuladoPor || "")}: ${esc(c.motivoAnulacion || "")}</span></div>` : ""}
          ${c.observaciones ? `<div class="sub"><span>${esc(c.observaciones)}</span></div>` : ""}
        </div>`).join("") : '<p class="suave">Todavía no hay cierres de la caja 2.</p>'}
    </div>`;

  $("hGuardarDeclara").addEventListener("click", async () => {
    const v = $("hDeclara").value.trim();
    if (!v) return mostrar("Escribe dónde se declara.", "mal");
    try {
      await setDoc(doc(db, "ajustes", "caja2"), { declaradaPor: v, actualizadoPor: estado.usuario.nombre, actualizadoEn: serverTimestamp() }, { merge: true });
      await pintarHistorial(cont);
      mostrar("Guardado.", "ok");
    } catch (e) { mostrar("No se ha podido guardar: " + traducirError(e.code || e.message), "mal"); }
  });

  cont.querySelectorAll(".hAnular").forEach((b) => b.addEventListener("click", async () => {
    const motivo = prompt("¿Por qué se anula este cierre?");
    if (!motivo || !motivo.trim()) return;
    try {
      await updateDoc(doc(db, "cierresCaja2", b.dataset.id), { anulado: true, motivoAnulacion: motivo.trim(), anuladoPor: estado.usuario.nombre, anuladoEn: serverTimestamp() });
      await pintarHistorial(cont);
      mostrar("Anulado. Ya puedes repetir el cierre de ese día.", "ok");
    } catch (e) { mostrar("No se ha podido anular: " + traducirError(e.code || e.message), "mal"); }
  }));

  $("hCompartir").addEventListener("click", async () => {
    const celda = (v) => { const t = String(v ?? ""); return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const filas = [["Fecha", "Contado", "Fondo", "Gastos", "Venta", "A caja roja", "Hecho por", "Se declara en"]];
    [...delTrim].reverse().forEach((c) => filas.push([fechaCorta(c.fecha), num2(c.totalRecuento), num2(c.fondo || FONDO), num2(c.totalGastos), num2(c.venta), num2(c.aRetirar), c.autorNombre || "", declaradaPor]));
    filas.push(["TOTAL", num2(suma(delTrim, "totalRecuento")), "", num2(suma(delTrim, "totalGastos")), num2(suma(delTrim, "venta")), num2(suma(delTrim, "aRetirar")), "", ""]);
    const archivo = new File(["\ufeff" + filas.map((f) => f.map(celda).join(";")).join("\r\n")], `caja2_${T.clave.replace("-", "_T")}.csv`, { type: "text/csv" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
        await navigator.share({ files: [archivo], title: "Caja 2 · " + T.nombre });
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
