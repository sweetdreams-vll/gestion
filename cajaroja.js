// =============================================================
// MÓDULO CAJA ROJA: el efectivo guardado del bar.
// Entra: lo retirado en cada cierre y otras entradas (dinero sacado del banco…).
// Sale: facturas pagadas en efectivo con la caja roja y otras salidas (ingresos en el banco…).
// Cada recuento fija el saldo real y muestra si cuadra con lo esperado.
// =============================================================
import {
  db, estado, ICONOS, $, esc, eur, eurSigno, leerEur, mostrar, traducirError,
  horaDe, ms, vigentes, claseDescuadre, claseEstado, textoDescuadre
} from "./nucleo.js?v=2";
import {
  collection, doc, getDocs, setDoc, updateDoc, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const moduloCajaRoja = {
  id: "cajaroja",
  titulo: "Caja roja",
  descripcion: "Efectivo guardado: saldo, entradas, salidas y recuentos",
  icono: ICONOS.caja,
  enBarra: false,
  roles: ["socio"],
  pestanas: [
    { id: "saldo", titulo: "Saldo" },
    { id: "movimientos", titulo: "Movimientos" }
  ],
  render: ({ sub, cont }) => sub === "movimientos" ? pintarMovimientos(cont) : pintarSaldo(cont),
  inicio: tarjetaInicio
};

const SUGERENCIAS_ENTRADA = ["Dinero sacado del banco", "Devolución de un proveedor", "Otro"];
const SUGERENCIAS_SALIDA = ["Ingreso en el banco", "Pago sin factura en la app", "Otro"];

// ---------- Cálculo del saldo ----------
async function calcularCajaRoja() {
  const [sm, sc, sk, sf] = await Promise.all([
    getDocs(collection(db, "cajaRoja")),
    getDocs(collection(db, "cierres")),
    getDocs(collection(db, "correcciones")),
    getDocs(query(collection(db, "facturas"), where("pagadaDesde", "==", "cajaRoja")))
  ]);

  const movimientos = [];
  sm.forEach((d) => movimientos.push({ id: d.id, ...d.data() }));
  const recuentos = movimientos.filter((m) => m.tipo === "recuento" && !m.anulado)
    .sort((a, b) => ms(a.creadoEn) - ms(b.creadoEn));
  const ultimo = recuentos[recuentos.length - 1] || null;
  const desde = ultimo ? ms(ultimo.creadoEn) : 0;

  const corr = {};
  sk.forEach((d) => { const c = d.data(); (corr[c.cierreId] ||= []).push(c); });
  Object.values(corr).forEach((l) => l.sort((a, b) => ms(a.creadoEn) - ms(b.creadoEn)));

  const lineas = [];
  sc.forEach((d) => {
    const c = d.data();
    if (ms(c.creadoEn) <= desde) return;
    const v = vigentes(c, corr[d.id]);
    lineas.push({ cuando: ms(c.creadoEn), texto: "Cierre del " + c.fecha.split("-").reverse().join("/"), quien: c.autorNombre, importe: v.aRetirar, origen: "cierre" });
  });
  sf.forEach((d) => {
    const f = d.data();
    if (f.anulada || ms(f.pagoEn) <= desde) return;
    lineas.push({ cuando: ms(f.pagoEn), texto: "Factura " + f.proveedorNombre + " " + f.numero, quien: f.pagoPor || f.autorNombre, importe: -f.total, origen: "factura", id: d.id });
  });
  movimientos.forEach((m) => {
    if (m.anulado || m.tipo === "recuento" || ms(m.creadoEn) <= desde) return;
    lineas.push({ cuando: ms(m.creadoEn), texto: m.concepto, quien: m.autorNombre, importe: m.tipo === "entrada" ? m.importe : -m.importe, origen: "manual", id: m.id });
  });
  lineas.sort((a, b) => b.cuando - a.cuando);

  const saldo = (ultimo ? ultimo.importe : 0) + lineas.reduce((s, l) => s + l.importe, 0);
  return { ultimo, recuentos, lineas, saldo, movimientos };
}

// ---------- Inicio ----------
async function tarjetaInicio(cont) {
  const r = await calcularCajaRoja();
  cont.innerHTML = `
    <div class="panel">
      <h2>Caja roja</h2>
      <div class="metricas">
        <div><small>Debería haber</small><strong>${eur(r.saldo)}</strong></div>
        <div><small>Último recuento</small><strong>${r.ultimo ? esc(horaDe(r.ultimo.creadoEn).slice(0, 10)) : "Ninguno"}</strong></div>
      </div>
      <a class="boton sec" href="#/cajaroja/saldo">Ver caja roja</a>
    </div>`;
}

// ---------- Saldo, recuento y nuevo movimiento ----------
async function pintarSaldo(cont) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const r = await calcularCajaRoja();
  const u = r.ultimo;
  cont.innerHTML = `
    <div class="panel">
      <h2>Debería haber</h2>
      <p style="font-size:2rem;font-weight:700;margin:0">${eur(r.saldo)}</p>
      ${u
        ? `<p class="suave" style="margin-bottom:0">Desde el último recuento (${esc(horaDe(u.creadoEn))}, ${esc(u.autorNombre)}: ${eur(u.importe)}) han entrado y salido ${r.lineas.length} movimientos.</p>`
        : `<div class="estado sobra" style="font-weight:400">Todavía no habéis contado la caja roja. Haz el primer recuento para empezar a controlarla desde hoy.</div>`}
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
    const dif = importe - r.saldo;
    const texto = r.ultimo ? "\n\nResultado: " + textoDescuadre(dif) : "\n\nEs el primer recuento: desde ahora se controlará la caja roja.";
    if (!confirm("¿Guardar el recuento de " + eur(importe) + "?" + texto)) return;
    try {
      await setDoc(doc(collection(db, "cajaRoja")), {
        tipo: "recuento", importe, teorico: r.saldo, diferencia: r.ultimo ? dif : 0,
        concepto: $("rNota").value.trim() || "Recuento",
        anulado: false, autorUid: estado.usuario.uid, autorNombre: estado.usuario.nombre, creadoEn: serverTimestamp()
      });
      await pintarSaldo(cont);
      mostrar(r.ultimo ? "Recuento guardado. " + textoDescuadre(dif) + "." : "Primer recuento guardado.", r.ultimo ? (dif === 0 ? "ok" : "mal") : "ok");
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

// ---------- Movimientos ----------
async function pintarMovimientos(cont) {
  cont.innerHTML = '<p class="suave">Cargando…</p>';
  const r = await calcularCajaRoja();
  const filas = r.lineas.map((l) => `
    <div class="item">
      <div class="top"><span>${esc(l.texto)}</span><span class="${l.importe < 0 ? "neg" : "cero"}">${eurSigno(l.importe)}</span></div>
      <div class="sub"><span>${esc(l.quien || "")}, ${esc(new Date(l.cuando).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }))}</span>
        ${l.origen === "manual" ? `<button class="sec mAnular" data-id="${esc(l.id)}" type="button" style="width:auto;margin:0;padding:4px 10px;font-size:.8rem">Anular</button>` : `<span>${l.origen === "cierre" ? "automático" : "factura"}</span>`}
      </div>
    </div>`).join("") || '<div class="panel">No hay movimientos desde el último recuento.</div>';

  const recuentos = [...r.recuentos].reverse().map((m) => `
    <div class="item">
      <div class="top"><span>${esc(horaDe(m.creadoEn))}</span><span>${eur(m.importe)}</span></div>
      <div class="sub"><span>${esc(m.autorNombre)}${m.concepto && m.concepto !== "Recuento" ? ", " + esc(m.concepto) : ""}</span>
        <span class="${claseDescuadre(m.diferencia || 0)}">${m.diferencia ? textoDescuadre(m.diferencia) : "Cuadra o primer recuento"}</span></div>
    </div>`).join("") || '<p class="suave">Todavía no hay recuentos.</p>';

  cont.innerHTML = `
    <div class="panel resumen" style="padding:6px 14px">
      <div><span>Debería haber ahora</span><strong>${eur(r.saldo)}</strong></div>
    </div>
    <div class="semana"><h3>Desde el último recuento</h3>${filas}</div>
    <div class="semana"><h3>Recuentos</h3>${recuentos}</div>`;

  cont.querySelectorAll(".mAnular").forEach((b) => b.addEventListener("click", async () => {
    const motivo = prompt("¿Por qué se anula este movimiento?");
    if (!motivo || !motivo.trim()) return;
    try {
      await updateDoc(doc(db, "cajaRoja", b.dataset.id), {
        anulado: true, motivoAnulacion: motivo.trim(), anuladoPor: estado.usuario.nombre, anuladoEn: serverTimestamp()
      });
      await pintarMovimientos(cont);
      mostrar("Movimiento anulado.", "ok");
    } catch (e) {
      mostrar("No se ha podido anular: " + traducirError(e.code || e.message), "mal");
    }
  }));
}
