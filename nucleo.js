// =============================================================
// NÚCLEO: conexión a Firebase, datos comunes y utilidades.
// Lo usan app.js y todos los módulos (caja.js, y más adelante compras.js, stock.js…).
// =============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const VERSION = "2";

const firebaseConfig = {
  apiKey: "AIzaSyDnNDk2BwqW7h_gB3mbsHl4VZKSM5LN_iA",
  authDomain: "sweet-dreams-gestion.firebaseapp.com",
  projectId: "sweet-dreams-gestion",
  storageBucket: "sweet-dreams-gestion.firebasestorage.app",
  messagingSenderId: "870404185505",
  appId: "1:870404185505:web:83c91b8dde7a4d42a5bfe0"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// ---------- Usuarios ----------
// El propietario (Brian) está fijado también en las reglas de Firestore: siempre es socio.
export const PROPIETARIO_UID = "MbrK5sSHwYQYzhslXDBOdAL1Erk1";
export const DOMINIO_EQUIPO = "sweetdreams.equipo";
// Nombres cortos para entrar sin escribir el correo completo
export const ALIAS_LOGIN = { brian: "sweetdreamsvalladolid.gestion@gmail.com" };

// Se crean solos la primera vez que Brian entra (colección "usuarios")
export const USUARIOS_INICIALES = [
  { uid: "MbrK5sSHwYQYzhslXDBOdAL1Erk1", nombre: "Brian", usuario: "brian", rol: "socio" },
  { uid: "PoLN5tj8LzVJSewok43D7FDni3E2", nombre: "Milito", usuario: "milito", rol: "socio" },
  { uid: "zfFwX3dgJxYF9ZqlJ4CS8svS5NC3", nombre: "Alba", usuario: "alba", rol: "equipo" }
];
export const ROLES = { socio: "Socio", encargado: "Encargado/a", equipo: "Equipo" };

// ---------- Ajustes (documento ajustes/general, editable por socios) ----------
export const AJUSTES_POR_DEFECTO = {
  fondoCambio: 25000, // en céntimos: 250 €
  gastosRapidos: ["Hieloneta", "DJ", "Camarero/a", "Portero", "Varios"],
  personas: []
};

export const BILLETES = [5000, 2000, 1000, 500, 200, 100, 50, 20, 10];

// Estado compartido de la sesión
export const estado = {
  usuario: null,          // { uid, email, nombre, rol, socio }
  ajustes: { ...AJUSTES_POR_DEFECTO },
  mensajePendiente: null
};

// ---------- Iconos de la barra inferior ----------
const svg = (contenido) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${contenido}</svg>`;
export const ICONOS = {
  inicio: svg('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>'),
  caja: svg('<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9.5v.01M18 14.5v.01"/>'),
  compras: svg('<path d="M3 6h11v10H3z"/><path d="M14 9h4l3 3v4h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>'),
  stock: svg('<path d="M10 3h4v3l1.5 2.5V20a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V8.5L10 6z"/><path d="M8.5 12h7"/>'),
  mas: svg('<path d="M4 7h16M4 12h16M4 17h16"/>')
};

// ---------- Utilidades ----------
export const $ = (id) => document.getElementById(id);

export function ir(ruta) { location.hash = "#/" + ruta; }

// Todos los importes se guardan en céntimos (enteros) para evitar errores de redondeo
export function eur(c) {
  return (c / 100).toLocaleString("es-ES", { style: "currency", currency: "EUR" });
}
export function eurSigno(c) { return (c > 0 ? "+" : "") + eur(c); }
export function etiquetaBillete(b) {
  return b >= 100 ? (b / 100) + " €" : (b / 100).toFixed(2).replace(".", ",") + " €";
}
// Devuelve céntimos, null si está vacío o NaN si no es un número válido
export function leerEur(texto) {
  let s = String(texto || "").trim().replace(/[€\s]/g, "");
  if (s === "") return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  if (!isFinite(n) || n < 0) return NaN;
  return Math.round(n * 100);
}
export function centimosATexto(c) { return (c / 100).toFixed(2).replace(".", ","); }
export function leerEntero(t) {
  const n = parseInt(String(t || "").trim(), 10);
  return isNaN(n) || n < 0 ? 0 : n;
}
export function esc(t) {
  return String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Fechas ----------
export function iso(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
export function deIso(t) {
  const [y, m, d] = t.split("-").map(Number);
  return new Date(y, m - 1, d);
}
// Antes de las 8 de la mañana, la jornada pertenece al día anterior (el día que se abrió)
export function fechaCajaHoy() {
  const d = new Date();
  if (d.getHours() < 8) d.setDate(d.getDate() - 1);
  return iso(d);
}
export function fechaLarga(t) {
  const s = deIso(t).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export function lunesDe(t) {
  const d = deIso(t);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return iso(d);
}
export function horaDe(ts) {
  if (!ts || !ts.toDate) return "";
  return ts.toDate().toLocaleString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function horaCorta(ts) {
  const d = ts && ts.toDate ? ts.toDate() : (ts instanceof Date ? ts : null);
  if (!d) return "";
  return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}
export function ms(ts) { return ts && ts.toMillis ? ts.toMillis() : Date.now(); }

// ---------- Mensajes ----------
export function mostrar(texto, tipo = "info") {
  const m = $("mensaje");
  m.className = tipo;
  m.textContent = texto;
  window.scrollTo({ top: 0, behavior: "smooth" });
}
export function mostrarDespues(texto, tipo = "info") { estado.mensajePendiente = [texto, tipo]; }
export function limpiarMensaje() {
  const m = $("mensaje");
  m.className = "";
  m.textContent = "";
}
export function traducirError(codigo) {
  switch (codigo) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-email":
      return "usuario o contraseña incorrectos.";
    case "auth/too-many-requests":
      return "demasiados intentos. Espera unos minutos.";
    case "auth/network-request-failed":
      return "no hay conexión a internet.";
    case "auth/weak-password":
      return "la contraseña es demasiado corta (mínimo 6 caracteres).";
    case "permission-denied":
      return "no tienes permiso para esto.";
    default:
      return codigo;
  }
}

// ---------- Cálculo de caja ----------
// Debería haber = fondo de cambio + efectivo del ticket − gastos pagados con la caja
export function calcular(v, fondo) {
  const deberiaHaber = fondo + v.ticketEfectivo - v.totalGastos;
  return {
    fondo,
    ticketEfectivo: v.ticketEfectivo,
    ticketTarjeta: v.ticketTarjeta,
    ticketTotal: v.ticketEfectivo + v.ticketTarjeta,
    totalRecuento: v.totalRecuento,
    totalGastos: v.totalGastos,
    deberiaHaber,
    descuadre: v.totalRecuento - deberiaHaber,
    aRetirar: v.totalRecuento - fondo
  };
}
export function fondoDe(c) { return typeof c.fondo === "number" ? c.fondo : AJUSTES_POR_DEFECTO.fondoCambio; }
// Valores de un cierre con sus correcciones aplicadas (manda la última de cada campo)
export function vigentes(c, corrs = []) {
  const v = {
    ticketEfectivo: c.ticketEfectivo,
    ticketTarjeta: c.ticketTarjeta,
    totalRecuento: c.totalRecuento,
    totalGastos: c.totalGastos
  };
  corrs.forEach((k) => { if (k.campo in v) v[k.campo] = k.valorNuevo; });
  return calcular(v, fondoDe(c));
}
export function claseDescuadre(c) { return c === 0 ? "cero" : (c < 0 ? "neg" : "pos"); }
export function claseEstado(c) { return c === 0 ? "ok" : (c < 0 ? "mal" : "sobra"); }
export function textoDescuadre(c) {
  if (c === 0) return "Cuadra";
  return c < 0 ? "Falta " + eur(-c) : "Sobra " + eur(c);
}
export function htmlResumen(r) {
  return `
    <div><span>Fondo de cambio</span><strong>${eur(r.fondo)}</strong></div>
    <div><span>+ Efectivo del ticket</span><strong>${eur(r.ticketEfectivo)}</strong></div>
    <div><span>− Gastos pagados</span><strong>${eur(r.totalGastos)}</strong></div>
    <div><span>= Debería haber en el cajón</span><strong>${eur(r.deberiaHaber)}</strong></div>
    <div><span>Contado de verdad</span><strong>${eur(r.totalRecuento)}</strong></div>
    <div><span>Descuadre</span><strong class="${claseDescuadre(r.descuadre)}">${r.descuadre === 0 ? "0,00 €" : eurSigno(r.descuadre)}</strong></div>
    <div><span>A retirar (dejando ${eur(r.fondo)} de cambio)</span><strong>${eur(r.aRetirar)}</strong></div>`;
}
