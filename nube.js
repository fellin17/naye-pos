// ─── NUBE (Firestore) — compartido por index.html, movil.html y rescate.html ──
// Firestore no acepta documentos de más de 1 MB. Antes todo el negocio vivía en
// un solo documento (naye_pos/data); al llenarse, la nube rechazaba cada guardado
// y la app regresaba a la versión anterior: el producto nuevo "desaparecía".
// Ahora los datos se reparten en varios documentos de la misma colección:
//   naye_pos/v2_config           → cfg (incluye el logo)
//   naye_pos/v2_productos_000…   → productos, en trozos de ~400 KB
//   naye_pos/v2_ventas_000…      → ventas
//   naye_pos/v2_cortes_000…      → cortes
// naye_pos/data ya no se modifica: queda como respaldo de cómo estaba todo.
const NubePOS = (function () {
  const FB_CFG = {
    apiKey:            "AIzaSyBLftuYYcSBporOE9EJ4Say_zJI7gYz2mQ",
    authDomain:        "naye-pos.firebaseapp.com",
    projectId:         "naye-pos",
    storageBucket:     "naye-pos.firebasestorage.app",
    messagingSenderId: "937595385178",
    appId:             "1:937595385178:web:a612a1844265710cdcaf63"
  };
  const PREFIJO = 'v2_';
  const FIN     = 'v2`';      // '`' es el carácter que sigue a '_': rango [v2_, v2`) = todos los v2_*
  const LISTAS  = { products: 'productos', sales: 'ventas', cuts: 'cortes' };
  const MAX_TROZO = 400000;   // bytes por documento (Firestore permite 1,048,576)
  const MAX_LOTE  = 4000000;  // bytes por escritura en lote (Firestore permite ~10 MB)

  let db = null, col = null;
  let enNube = null;          // id → texto de cada documento v2 que hay en la nube (null = aún no se sabe)
  let conociendo = null;
  // Nada se sube hasta haber bajado lo que ya hay en la nube. Antes, un navegador sin copia
  // local (celular nuevo, caché borrada) subía su estado vacío al abrir y borraba todo.
  let sincronizado = false;
  let avisar = e => console.warn('Nube:', e.message);

  function iniciar() {
    if (col) return true;
    try {
      if (!firebase.apps.length) firebase.initializeApp(FB_CFG);
      db = firebase.firestore();
      try { db.settings({ ignoreUndefinedProperties: true, merge: true }); } catch (e) {}
      col = db.collection('naye_pos');
      return true;
    } catch (e) { console.warn('Firebase init:', e.message); return false; }
  }

  // ── Tamaño aproximado con las reglas de Firestore (texto = bytes UTF-8 + 1, número = 8…)
  function bytesUtf8(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c < 0xDC00) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  function tamano(v) {
    if (v === null || v === undefined) return 1;
    if (typeof v === 'string')  return bytesUtf8(v) + 1;
    if (typeof v === 'number')  return 8;
    if (typeof v === 'boolean') return 1;
    if (Array.isArray(v)) return v.reduce((t, x) => t + tamano(x), 0);
    let t = 0;
    for (const k in v) t += bytesUtf8(k) + 1 + tamano(v[k]);
    return t;
  }

  // ── JSON con llaves ordenadas: la nube devuelve las llaves en otro orden
  function texto(v) {
    if (Array.isArray(v)) return '[' + v.map(texto).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort()
        .map(k => JSON.stringify(k) + ':' + texto(v[k])).join(',') + '}';
    }
    return v === undefined ? 'null' : JSON.stringify(v);
  }

  // ── { products, sales, cuts, cfg } ⇄ documentos v2_*
  function repartir(data) {
    const docs = {};
    docs[PREFIJO + 'config'] = { cfg: data.cfg || {} };
    for (const k in LISTAS) {
      let trozo = [], peso = 0, n = 0;
      const cerrar = () => {
        docs[PREFIJO + LISTAS[k] + '_' + String(n++).padStart(3, '0')] = { items: trozo };
        trozo = []; peso = 0;
      };
      for (const x of data[k] || []) {
        const t = tamano(x);
        if (trozo.length && peso + t > MAX_TROZO) cerrar();
        trozo.push(x); peso += t;
      }
      if (trozo.length) cerrar();
    }
    return docs;
  }

  function juntar(docs) {
    if (!docs.length) return null;
    const d = { products: [], sales: [], cuts: [], cfg: {} };
    docs.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).forEach(x => {
      if (x.id === PREFIJO + 'config') { d.cfg = x.data.cfg || {}; return; }
      for (const k in LISTAS) {
        if (x.id.startsWith(PREFIJO + LISTAS[k] + '_')) d[k].push(...(x.data.items || []));
      }
    });
    return d;
  }

  function consulta() {
    const id = firebase.firestore.FieldPath.documentId();
    return col.where(id, '>=', PREFIJO).where(id, '<', FIN);
  }
  function aDocs(snap) { return snap.docs.map(d => ({ id: d.id, data: d.data() })); }
  function recordar(docs) {
    enNube = {};
    docs.forEach(x => { enNube[x.id] = texto(x.data); });
  }
  function conocerNube() {
    if (!conociendo) {
      conociendo = consulta().get()
        .then(s => recordar(aDocs(s)))
        .finally(() => { conociendo = null; });
    }
    return conociendo;
  }

  // Devuelve { products, sales, cuts, cfg }, o null si la nube no tiene nada.
  async function cargar() {
    const docs = aDocs(await consulta().get());
    recordar(docs);
    if (docs.length) { sincronizado = true; return juntar(docs); }
    // Primera vez con esta versión: leer el documento viejo y pasarlo al formato nuevo
    const viejo = await col.doc('data').get();
    sincronizado = true;
    if (!viejo.exists) return null;
    const d = viejo.data();
    guardar(d);
    return d;
  }

  // Solo sube los documentos que cambiaron y borra los trozos que sobran.
  // Las escrituras se mandan en el mismo orden en que se llama a guardar().
  function escribir(data, forzar) {
    const vacio = !Object.keys(LISTAS).some(k => (data[k] || []).length);
    if (vacio && !forzar && Object.keys(enNube).some(id => id !== PREFIJO + 'config')) {
      return Promise.reject(new Error('Protección: no se borran todos los datos de la nube'));
    }
    const nuevos = repartir(data);
    const ops = [];
    for (const id in nuevos) {
      const t = texto(nuevos[id]);
      if (enNube[id] !== t) ops.push({ id, datos: nuevos[id], t });
    }
    for (const id in enNube) if (!(id in nuevos)) ops.push({ id });
    if (!ops.length) return Promise.resolve();

    // Un solo lote (todo o nada); solo se parte si el cambio es enorme, p. ej. al restaurar un respaldo
    const lotes = [];
    let lote = db.batch(), peso = 0, n = 0;
    for (const op of ops) {
      const t = op.t ? op.t.length : 0;
      if (n && (peso + t > MAX_LOTE || n >= 400)) { lotes.push(lote); lote = db.batch(); peso = 0; n = 0; }
      if (op.datos) lote.set(col.doc(op.id), op.datos);
      else lote.delete(col.doc(op.id));
      peso += t; n++;
    }
    lotes.push(lote);
    ops.forEach(op => { if (op.datos) enNube[op.id] = op.t; else delete enNube[op.id]; });
    return Promise.all(lotes.map(l => l.commit())).catch(e => { enNube = null; throw e; });
  }

  // Nunca lanza error: si la nube rechaza el guardado, avisa con la función de alFallar().
  // forzar: subir aunque no se haya bajado la nube (rescate) o aunque quede vacía (borrar todo).
  function guardar(data, forzar) {
    if (!col) return Promise.resolve(false);
    if (!sincronizado && !forzar) {
      console.warn('Nube: aún no se bajan los datos de la nube; este cambio solo se guardó en el dispositivo');
      return Promise.resolve(false);
    }
    const p = enNube ? escribir(data, forzar) : conocerNube().then(() => escribir(data, forzar));
    return p.then(() => true, e => { avisar(e); return false; });
  }

  function escuchar(cb, alFallarEscucha) {
    if (!col) return;
    consulta().onSnapshot(snap => {
      const docs = aDocs(snap);
      recordar(docs);
      if (docs.length) sincronizado = true;
      const d = juntar(docs);
      if (d) cb(d);
    }, e => (alFallarEscucha || avisar)(e));
  }

  return {
    iniciar, cargar, guardar, escuchar, repartir, juntar, tamano,
    alFallar(fn) { avisar = fn; }
  };
})();
