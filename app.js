// =============================================================
// APP: sesión, navegación (barra inferior y pestañas), Inicio, Más,
// Mi cuenta, Ajustes y Equipo. Los módulos van en archivos aparte.
// =============================================================
import {
  auth, db, estado, PROPIETARIO_UID, DOMINIO_EQUIPO, ALIAS_LOGIN, USUARIOS_INICIALES, ROLES,
  AJUSTES_POR_DEFECTO, $, esc, eur, leerEur, centimosATexto, mostrar, mostrarDespues, limpiarMensaje,
  traducirError, fechaLarga, fechaCajaHoy, ir, ICONOS
} from "./nucleo.js?v=2";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, getDocs, setDoc, updateDoc, collection, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { moduloCaja } from "./caja.js?v=3";
import { moduloCompras } from "./compras.js?v=3";
import { moduloCajaRoja } from "./cajaroja.js?v=3";

// ---------- Módulos ----------
// Para añadir un módulo nuevo: importarlo arriba y añadirlo a esta lista.
// enBarra: true = aparece en la barra inferior; false = aparece en «Más».
const MODULOS = [moduloCaja, moduloCompras, moduloCajaRoja];

const PROXIMAMENTE = [
  "Stock", "Carta y escandallos", "Personal",
  "Cierre trimestral", "Panel de control", "Obligaciones del local"
];

function puedeVer(roles) { return !roles || roles.includes(estado.usuario.rol); }
function modulosVisibles() { return MODULOS.filter((m) => puedeVer(m.roles)); }
function ruta() {
  return location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
}

// ---------- Sesión ----------
onAuthStateChanged(auth, async (u) => {
  $("carga").classList.add("oculto");
  $("app").classList.remove("oculto");
  if (!u) {
    estado.usuario = null;
    pintar();
    return;
  }
  try {
    let perfil = await leerPerfil(u.uid);
    if (!perfil && u.uid === PROPIETARIO_UID) {
      await prepararPrimeraVez();
      perfil = await leerPerfil(u.uid);
    }
    if (!perfil || perfil.activo === false) {
      mostrarDespues("Este usuario no tiene acceso a la app. Habla con Brian.", "mal");
      await signOut(auth);
      return;
    }
    estado.usuario = {
      uid: u.uid,
      email: u.email,
      nombre: perfil.nombre,
      rol: u.uid === PROPIETARIO_UID ? "socio" : perfil.rol,
    };
    estado.usuario.socio = estado.usuario.rol === "socio";
    await cargarAjustes();
    pintar();
  } catch (e) {
    mostrar("No se ha podido cargar tu usuario: " + traducirError(e.code || e.message), "mal");
  }
});

async function leerPerfil(uid) {
  const s = await getDoc(doc(db, "usuarios", uid));
  return s.exists() ? s.data() : null;
}

// La primera vez que entra Brian se crean los usuarios y los ajustes
async function prepararPrimeraVez() {
  const lote = writeBatch(db);
  USUARIOS_INICIALES.forEach((p) => {
    lote.set(doc(db, "usuarios", p.uid), {
      nombre: p.nombre, usuario: p.usuario, rol: p.rol, activo: true,
      creadoPor: "Brian", creadoEn: serverTimestamp()
    });
  });
  const aj = await getDoc(doc(db, "ajustes", "general"));
  if (!aj.exists()) {
    lote.set(doc(db, "ajustes", "general"), { ...AJUSTES_POR_DEFECTO, actualizadoPor: "Brian", actualizadoEn: serverTimestamp() });
  }
  await lote.commit();
}

async function cargarAjustes() {
  try {
    const s = await getDoc(doc(db, "ajustes", "general"));
    estado.ajustes = { ...AJUSTES_POR_DEFECTO, ...(s.exists() ? s.data() : {}) };
  } catch (e) {
    estado.ajustes = { ...AJUSTES_POR_DEFECTO };
  }
}

// ---------- Navegación ----------
window.addEventListener("hashchange", pintar);

function pintar() {
  limpiarMensaje();
  if (estado.mensajePendiente) {
    mostrar(...estado.mensajePendiente);
    estado.mensajePendiente = null;
  }
  const cont = $("contenido");
  $("pestanas").classList.add("oculto");
  $("pestanas").innerHTML = "";

  if (!estado.usuario) { pintarLogin(cont); return; }

  const partes = ruta();
  const seccion = partes[0] || "inicio";
  const u = estado.usuario;
  $("quien").textContent = u.nombre + " (" + (ROLES[u.rol] || u.rol).toLowerCase() + ")";
  pintarBarra(seccion);
  window.scrollTo(0, 0);

  if (seccion === "inicio") { $("titulo").textContent = "Sweet Dreams"; pintarInicio(cont); return; }
  if (seccion === "mas") { $("titulo").textContent = "Más"; pintarMas(cont, partes[1]); return; }

  const m = modulosVisibles().find((x) => x.id === seccion);
  if (!m) { ir("inicio"); return; }
  $("titulo").textContent = m.titulo;

  const pestanas = m.pestanas.filter((p) => puedeVer(p.roles));
  let p = pestanas.find((x) => x.id === partes[1]);
  if (!p) p = pestanas.find((x) => !x.oculta);
  const activa = p.oculta ? p.padre : p.id;
  const visibles = pestanas.filter((x) => !x.oculta);
  if (visibles.length > 1) {
    $("pestanas").innerHTML = visibles
      .map((x) => `<a href="#/${m.id}/${x.id}" class="${x.id === activa ? "activo" : ""}">${esc(x.titulo)}</a>`)
      .join("");
    $("pestanas").classList.remove("oculto");
  }
  cont.innerHTML = "";
  Promise.resolve(m.render({ sub: p.id, resto: partes.slice(2), cont }))
    .catch((e) => mostrar("Error: " + traducirError(e.code || e.message), "mal"));
}

function pintarBarra(seccion) {
  const items = [
    { id: "inicio", titulo: "Inicio", icono: ICONOS.inicio },
    ...modulosVisibles().filter((m) => m.enBarra),
    { id: "mas", titulo: "Más", icono: ICONOS.mas }
  ];
  $("barra").innerHTML = items
    .map((i) => `<a href="#/${i.id}" class="${i.id === seccion ? "activo" : ""}">${i.icono}<span>${esc(i.titulo)}</span></a>`)
    .join("");
  $("barra").classList.remove("oculto");
}

// ---------- Entrar ----------
function pintarLogin(cont) {
  $("barra").classList.add("oculto");
  $("titulo").textContent = "Sweet Dreams";
  $("quien").textContent = "Gestión interna";
  cont.innerHTML = `
    <section class="panel">
      <h2>Entrar</h2>
      <label for="lUsuario">Usuario</label>
      <input id="lUsuario" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="alba">
      <label for="lClave">Contraseña</label>
      <input id="lClave" type="password" autocomplete="current-password">
      <button id="bEntrar" type="button">Entrar</button>
    </section>`;
  const entrar = async () => {
    let user = $("lUsuario").value.trim().toLowerCase();
    if (!user) return mostrar("Escribe tu usuario.", "mal");
    if (ALIAS_LOGIN[user]) user = ALIAS_LOGIN[user];
    if (!user.includes("@")) user = user + "@" + DOMINIO_EQUIPO;
    $("bEntrar").disabled = true;
    try {
      await signInWithEmailAndPassword(auth, user, $("lClave").value);
      if (!location.hash || location.hash === "#/") location.hash = "#/inicio";
    } catch (e) {
      mostrar("No se ha podido entrar: " + traducirError(e.code), "mal");
      $("bEntrar").disabled = false;
    }
  };
  $("bEntrar").addEventListener("click", entrar);
  $("lClave").addEventListener("keydown", (e) => { if (e.key === "Enter") entrar(); });
}

// ---------- Inicio ----------
function pintarInicio(cont) {
  const u = estado.usuario;
  cont.innerHTML = `
    <div class="panel">
      <h2>Hola, ${esc(u.nombre)}</h2>
      <p class="suave" style="margin:0">Jornada del ${esc(fechaLarga(fechaCajaHoy()).toLowerCase())}</p>
    </div>
    <div id="tarjetasInicio"></div>`;
  // Cada módulo puede aportar su propia tarjeta al Inicio
  modulosVisibles().filter((m) => m.inicio).forEach((m) => {
    const d = document.createElement("div");
    $("tarjetasInicio").appendChild(d);
    Promise.resolve(m.inicio(d)).catch((e) => {
      d.innerHTML = `<div class="panel suave">No se ha podido cargar ${esc(m.titulo)}: ${esc(e.message)}</div>`;
    });
  });
}

// ---------- Más ----------
function opcion(href, titulo, detalle) {
  return `<a class="opcion" href="${href}"><span>${esc(titulo)}<small>${esc(detalle)}</small></span><span class="flecha" aria-hidden="true">›</span></a>`;
}

function pintarMas(cont, sub) {
  const socio = estado.usuario.socio;
  if (sub === "cuenta") return pintarCuenta(cont);
  if (sub === "ajustes" && socio) return pintarAjustes(cont);
  if (sub === "equipo" && socio) return pintarEquipo(cont);

  let html = `<div class="panel">`;
  modulosVisibles().filter((m) => !m.enBarra).forEach((m) => { html += opcion(`#/${m.id}`, m.titulo, m.descripcion || ""); });
  html += opcion("#/mas/cuenta", "Mi cuenta", "Cambiar contraseña y cerrar sesión");
  if (socio) {
    html += opcion("#/mas/ajustes", "Ajustes", "Fondo de cambio, gastos rápidos y personas habituales");
    html += opcion("#/mas/equipo", "Equipo y permisos", "Quién entra en la app y qué puede ver");
  }
  html += `</div>`;
  if (socio) {
    html += `<div class="panel"><h2>Próximamente</h2><p class="suave" style="margin:0">${PROXIMAMENTE.map(esc).join(", ")}.</p></div>`;
  }
  cont.innerHTML = html;
}

function pintarCuenta(cont) {
  const u = estado.usuario;
  cont.innerHTML = `
    <a class="volver" href="#/mas">‹ Más</a>
    <div class="panel">
      <h2>Mi cuenta</h2>
      <div class="resumen">
        <div><span>Nombre</span><strong>${esc(u.nombre)}</strong></div>
        <div><span>Permisos</span><strong>${esc(ROLES[u.rol] || u.rol)}</strong></div>
      </div>
    </div>
    <div class="panel">
      <h2>Cambiar contraseña</h2>
      <label for="kActual">Contraseña actual</label>
      <input id="kActual" type="password" autocomplete="current-password">
      <label for="kNueva">Contraseña nueva (mínimo 6 caracteres)</label>
      <input id="kNueva" type="password" autocomplete="new-password">
      <label for="kRepite">Repite la contraseña nueva</label>
      <input id="kRepite" type="password" autocomplete="new-password">
      <button id="bCambiarClave" type="button">Cambiar contraseña</button>
    </div>
    <div class="panel">
      <h2>Cerrar sesión</h2>
      <p class="suave" style="margin:0">Solo hace falta si vas a dejar este móvil a otra persona.</p>
      <button class="peligro" id="bSalir" type="button">Cerrar sesión</button>
    </div>`;

  $("bCambiarClave").addEventListener("click", async () => {
    const nueva = $("kNueva").value;
    if (nueva.length < 6) return mostrar("La contraseña nueva debe tener al menos 6 caracteres.", "mal");
    if (nueva !== $("kRepite").value) return mostrar("Las dos contraseñas nuevas no coinciden.", "mal");
    try {
      const cu = auth.currentUser;
      await reauthenticateWithCredential(cu, EmailAuthProvider.credential(cu.email, $("kActual").value));
      await updatePassword(cu, nueva);
      ["kActual", "kNueva", "kRepite"].forEach((i) => ($(i).value = ""));
      mostrar("Contraseña cambiada. Úsala la próxima vez que entres.", "ok");
    } catch (e) {
      mostrar("No se ha podido cambiar: " + traducirError(e.code), "mal");
    }
  });

  $("bSalir").addEventListener("click", async () => {
    if (!confirm("¿Cerrar la sesión en este móvil? Tendrás que volver a escribir tu usuario y contraseña.")) return;
    history.replaceState(null, "", "#/inicio");
    await signOut(auth);
  });
}

function pintarAjustes(cont) {
  const a = estado.ajustes;
  cont.innerHTML = `
    <a class="volver" href="#/mas">‹ Más</a>
    <div class="panel">
      <h2>Caja</h2>
      <label for="aFondo">Fondo de cambio (€)</label>
      <input id="aFondo" inputmode="decimal" value="${esc(centimosATexto(a.fondoCambio))}">
      <small class="nota">Se aplica a los cierres nuevos. Los cierres ya guardados conservan el fondo que tenían.</small>
      <label for="aGastos">Botones rápidos de gastos (uno por línea)</label>
      <textarea id="aGastos" rows="6">${esc(a.gastosRapidos.join("\n"))}</textarea>
      <label for="aPersonas">Personas habituales: DJ, porteros, camareros… (una por línea)</label>
      <textarea id="aPersonas" rows="6">${esc((a.personas || []).join("\n"))}</textarea>
      <small class="nota">Aparecerán como sugerencia al apuntar un gasto, para no tener que escribirlas cada noche.</small>
      <button id="bGuardarAjustes" type="button">Guardar ajustes</button>
    </div>`;

  const lineas = (t) => [...new Set(t.split("\n").map((x) => x.trim()).filter(Boolean))];
  $("bGuardarAjustes").addEventListener("click", async () => {
    const fondo = leerEur($("aFondo").value);
    if (fondo === null || isNaN(fondo)) return mostrar("Escribe un fondo de cambio válido en euros.", "mal");
    const datos = {
      fondoCambio: fondo,
      gastosRapidos: lineas($("aGastos").value),
      personas: lineas($("aPersonas").value),
      actualizadoPor: estado.usuario.nombre,
      actualizadoEn: serverTimestamp()
    };
    try {
      await setDoc(doc(db, "ajustes", "general"), datos, { merge: true });
      estado.ajustes = { ...estado.ajustes, ...datos };
      mostrar("Ajustes guardados.", "ok");
    } catch (e) {
      mostrar("No se han podido guardar: " + traducirError(e.code || e.message), "mal");
    }
  });
}

async function pintarEquipo(cont) {
  const opcionesRol = (sel) => Object.entries(ROLES)
    .map(([k, v]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(v)}</option>`).join("");

  cont.innerHTML = `
    <a class="volver" href="#/mas">‹ Más</a>
    <div class="panel">
      <h2>Equipo y permisos</h2>
      <p class="suave" style="margin:0;line-height:1.5">Socio: lo ve todo y puede corregir. Encargado/a: de momento igual que equipo; más adelante tendrá más acceso. Equipo: hace el cierre y solo ve el suyo. Los cambios se aplican la próxima vez que esa persona entre.</p>
    </div>
    <div id="eLista"><p class="suave">Cargando…</p></div>
    <div class="panel">
      <h2>Añadir persona</h2>
      <p class="suave" style="margin-top:0;line-height:1.5">Primero, en Firebase › Authentication › Usuarios, crea su usuario con el correo <code>nombre@${DOMINIO_EQUIPO}</code> y una contraseña provisional. Después copia su UID aquí.</p>
      <label for="eNombre">Nombre</label>
      <input id="eNombre" placeholder="Manu">
      <label for="eUsuario">Usuario para entrar</label>
      <input id="eUsuario" autocapitalize="none" spellcheck="false" placeholder="manu">
      <label for="eUid">UID de Firebase</label>
      <input id="eUid" autocapitalize="none" spellcheck="false">
      <label for="eRol">Permisos</label>
      <select id="eRol">${opcionesRol("equipo")}</select>
      <button id="bAnadir" type="button">Añadir persona</button>
    </div>`;

  const cargar = async () => {
    const s = await getDocs(collection(db, "usuarios"));
    const lista = [];
    s.forEach((d) => lista.push({ uid: d.id, ...d.data() }));
    lista.sort((a, b) => a.nombre.localeCompare(b.nombre));
    $("eLista").innerHTML = lista.map((p) => {
      const fijo = p.uid === PROPIETARIO_UID;
      return `
        <div class="panel" data-uid="${esc(p.uid)}">
          <h2>${esc(p.nombre)} <span class="suave" style="font-weight:400">(${esc(p.usuario || "")})</span></h2>
          ${fijo
            ? `<p class="suave" style="margin:0">Propietario: siempre es socio.</p>`
            : `<label>Permisos</label><select class="eRolFila">${opcionesRol(p.rol)}</select>
               <label class="check"><input type="checkbox" class="eActivo" ${p.activo !== false ? "checked" : ""}> Puede entrar en la app</label>
               <button class="sec eGuardar" type="button">Guardar cambios</button>`}
        </div>`;
    }).join("");
  };

  $("eLista").addEventListener("click", async (e) => {
    const b = e.target.closest(".eGuardar");
    if (!b) return;
    const fila = b.closest("[data-uid]");
    try {
      await updateDoc(doc(db, "usuarios", fila.dataset.uid), {
        rol: fila.querySelector(".eRolFila").value,
        activo: fila.querySelector(".eActivo").checked,
        actualizadoPor: estado.usuario.nombre,
        actualizadoEn: serverTimestamp()
      });
      mostrar("Cambios guardados.", "ok");
    } catch (err) {
      mostrar("No se han podido guardar: " + traducirError(err.code || err.message), "mal");
    }
  });

  $("bAnadir").addEventListener("click", async () => {
    const nombre = $("eNombre").value.trim();
    const usuario = $("eUsuario").value.trim().toLowerCase();
    const uid = $("eUid").value.trim();
    if (!nombre || !usuario || uid.length < 20) return mostrar("Rellena nombre, usuario y el UID completo.", "mal");
    try {
      const ref = doc(db, "usuarios", uid);
      if ((await getDoc(ref)).exists()) return mostrar("Esa persona ya está en la lista.", "mal");
      await setDoc(ref, {
        nombre, usuario, rol: $("eRol").value, activo: true,
        creadoPor: estado.usuario.nombre, creadoEn: serverTimestamp()
      });
      ["eNombre", "eUsuario", "eUid"].forEach((i) => ($(i).value = ""));
      mostrar(nombre + " añadido. Ya puede entrar con el usuario «" + usuario + "».", "ok");
      await cargar();
    } catch (e) {
      mostrar("No se ha podido añadir: " + traducirError(e.code || e.message), "mal");
    }
  });

  try { await cargar(); } catch (e) { $("eLista").innerHTML = ""; mostrar("No se ha podido cargar el equipo: " + traducirError(e.code || e.message), "mal"); }
}
