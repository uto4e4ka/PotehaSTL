// Injected into the page (MAIN world) from the popup.
// Finds the largest three.js scene, bakes every visible mesh into world space
// (dequantizing, applying skinning/morphs and instancing) and saves .glb or .stl.
(async () => {
  const isTop = window === window.top;
  const FORMAT = window.__potehaSTLFormat === 'stl' ? 'stl' : 'glb';
  const stlParts = []; // { pos: Float32Array (world space), idx: Uint32Array }

  const toast = (msg, ok = true) => {
    try {
      const d = document.createElement('div');
      d.textContent = msg;
      Object.assign(d.style, {
        position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483647,
        padding: '10px 14px', borderRadius: '8px', font: '13px/1.4 system-ui, sans-serif',
        color: '#fff', background: ok ? '#1f7a3a' : '#8a2a2a',
        boxShadow: '0 4px 16px rgba(0,0,0,.3)', maxWidth: '360px', whiteSpace: 'pre-line',
      });
      document.documentElement.appendChild(d);
      setTimeout(() => d.remove(), 5000);
    } catch (e) { /* ignore */ }
    console.log('[PotehaSTL]', msg);
  };

  // ---------- 1. Find scenes ----------
  const rootOf = (o) => { while (o && o.parent) o = o.parent; return o; };
  const scenes = new Set();

  for (const r of (window.__potehaSTL?.refs || [])) {
    const o = r.deref && r.deref();
    if (o && o.isObject3D) scenes.add(rootOf(o));
  }

  // Globals (window.scene, window.app.scene, window.viewer.scene ...)
  for (const k of Object.keys(window)) {
    let v; try { v = window[k]; } catch (e) { continue; }
    if (!v || typeof v !== 'object') continue;
    try {
      if (v.isObject3D) { scenes.add(rootOf(v)); continue; }
      for (const kk of ['scene', '_scene', 'world']) {
        const s = v[kk];
        if (s && s.isObject3D) scenes.add(rootOf(s));
      }
    } catch (e) { /* ignore */ }
  }

  // React fiber walk from every canvas (react-three-fiber, custom React viewers)
  const scanFiberValue = (() => {
    const SKIP = new Set(['return', 'child', 'sibling', 'alternate', '_owner', 'stateNode', 'dependencies']);
    return (start) => {
      const seen = new WeakSet();
      const walk = (o, lvl) => {
        if (!o || typeof o !== 'object' || lvl > 7 || seen.has(o)) return null;
        seen.add(o);
        if (o.isObject3D) return o;
        if (typeof Node !== 'undefined' && o instanceof Node) return null;
        if (typeof o.getState === 'function') {
          try { const s = o.getState(); if (s && s.scene && s.scene.isObject3D) return s.scene; } catch (e) { /* */ }
        }
        if (Array.isArray(o)) {
          for (const v of o.slice(0, 50)) { const r = walk(v, lvl + 1); if (r) return r; }
          return null;
        }
        let keys; try { keys = Object.keys(o).slice(0, 80); } catch (e) { return null; }
        for (const k of keys) {
          if (SKIP.has(k)) continue;
          let v; try { v = o[k]; } catch (e) { continue; }
          if (v && typeof v === 'object') { const r = walk(v, lvl + 1); if (r) return r; }
        }
        return null;
      };
      return walk(start, 0);
    };
  })();

  for (const c of document.querySelectorAll('canvas')) {
    const fk = Object.keys(c).find((k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
    if (!fk) continue;
    let f = c[fk], d = 0;
    while (f && d < 100) {
      let h = f.memoizedState, i = 0;
      while (h && typeof h === 'object' && i < 80) {
        const r = scanFiberValue(h.memoizedState);
        if (r) scenes.add(rootOf(r));
        h = h.next; i++;
      }
      const p = scanFiberValue(f.memoizedProps);
      if (p) scenes.add(rootOf(p));
      f = f.return; d++;
    }
  }

  // ---------- 2. Pick the biggest scene ----------
  const isHelperQuad = (m) =>
    (m.material?.isShaderMaterial || m.material?.isRawShaderMaterial) &&
    (m.geometry.attributes.position?.count || 0) <= 4;

  const collectMeshes = (scene) => {
    const out = [];
    scene.updateMatrixWorld(true);
    scene.traverseVisible((o) => {
      if (o.isMesh && o.geometry?.attributes?.position && !isHelperQuad(o)) out.push(o);
    });
    return out;
  };
  const triCount = (meshes) => meshes.reduce((s, m) => {
    const g = m.geometry;
    const n = g.index ? g.index.count : g.attributes.position.count;
    return s + (n / 3) * (m.isInstancedMesh ? m.count : 1);
  }, 0);

  let best = null, bestTris = 0, bestMeshes = [];
  for (const s of scenes) {
    try {
      const ms = collectMeshes(s);
      const t = triCount(ms);
      if (t > bestTris) { best = s; bestTris = t; bestMeshes = ms; }
    } catch (e) { /* ignore broken scene */ }
  }

  if (!best) {
    if (isTop) toast('Сцена three.js не найдена.\nПопробуйте перезагрузить страницу и нажать ещё раз,\nкогда модель уже видна.', false);
    return;
  }

  // ---------- 3. Build GLB ----------
  const chunks = []; let byteLen = 0;
  const bufferViews = [], accessors = [], images = [], textures = [], materials = [], meshesOut = [], nodes = [];
  const warnings = [];

  const addView = (typed, target) => {
    const pad = (4 - (byteLen % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); byteLen += pad; }
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    chunks.push(bytes);
    const view = { buffer: 0, byteOffset: byteLen, byteLength: bytes.byteLength };
    if (target) view.target = target;
    byteLen += bytes.byteLength;
    bufferViews.push(view);
    return bufferViews.length - 1;
  };
  const addAccessor = (typed, type, componentType, count, target, extra = {}) => {
    accessors.push({ bufferView: addView(typed, target), componentType, count, type, ...extra });
    return accessors.length - 1;
  };

  // Textures
  const imageCache = new Map();
  const textureToPng = async (tex) => {
    const img = tex?.image;
    if (!img) return null;
    if (imageCache.has(img)) return imageCache.get(img);
    let result = null;
    try {
      const w = img.naturalWidth || img.videoWidth || img.width;
      const h = img.naturalHeight || img.videoHeight || img.height;
      if (!w || !h) throw new Error('no size');
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      if (img.data && !(img instanceof HTMLElement)) {
        // DataTexture: raw RGBA bytes
        if (!(img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray) || img.data.length !== w * h * 4) {
          throw new Error('unsupported DataTexture format');
        }
        ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), w, h), 0, 0);
      } else {
        ctx.drawImage(img, 0, 0);
      }
      const blob = await new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      images.push({ bufferView: addView(bytes), mimeType: 'image/png' });
      textures.push({ source: images.length - 1, sampler: 0 });
      result = textures.length - 1;
    } catch (e) {
      warnings.push('текстура пропущена (' + (e.message || e) + ')');
    }
    imageCache.set(img, result);
    return result;
  };

  // Materials
  const matCache = new Map();
  const toMaterial = async (mat) => {
    if (!mat) mat = {};
    if (matCache.has(mat)) return matCache.get(mat);
    const c = mat.color || { r: 1, g: 1, b: 1 };
    const opacity = mat.opacity ?? 1;
    const pbr = {
      baseColorFactor: [c.r, c.g, c.b, opacity],
      metallicFactor: mat.metalness ?? 0,
      roughnessFactor: mat.roughness ?? 1,
    };
    if (mat.map && FORMAT === 'glb') {
      const t = await textureToPng(mat.map);
      if (t !== null) pbr.baseColorTexture = { index: t };
    }
    const out = { name: mat.name || undefined, pbrMetallicRoughness: pbr };
    if (mat.side === 2) out.doubleSided = true;
    if (mat.transparent && opacity < 1) out.alphaMode = 'BLEND';
    if (mat.alphaTest > 0) { out.alphaMode = 'MASK'; out.alphaCutoff = mat.alphaTest; }
    materials.push(out);
    matCache.set(mat, materials.length - 1);
    return materials.length - 1;
  };

  for (const mesh of bestMeshes) {
    const g = mesh.geometry;
    const A = g.attributes;
    const n = A.position.count;
    const instances = mesh.isInstancedMesh ? mesh.count : 1;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const V3 = mesh.position.constructor;
    const vtx = new V3();
    const nrm = new V3();

    // UV transform from the first material that has a map
    const mapTex = mats.find((m) => m?.map)?.map;
    let uvM = null, flipY = false;
    if (mapTex) {
      try { mapTex.updateMatrix(); uvM = mapTex.matrix.elements; } catch (e) { uvM = null; }
      flipY = !!mapTex.flipY;
    }

    for (let k = 0; k < instances; k++) {
      const M = mesh.matrixWorld.clone();
      if (mesh.isInstancedMesh) {
        const im = mesh.matrixWorld.clone();
        mesh.getMatrixAt(k, im);
        M.multiply(im);
      }
      const NM = M.clone().invert().transpose().elements;
      const mirrored = M.determinant() < 0;

      const pos = new Float32Array(n * 3);
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      const canDeform = typeof mesh.getVertexPosition === 'function' && !mesh.isInstancedMesh;
      for (let i = 0; i < n; i++) {
        if (canDeform) mesh.getVertexPosition(i, vtx); else vtx.fromBufferAttribute(A.position, i);
        vtx.applyMatrix4(M);
        pos[i * 3] = vtx.x; pos[i * 3 + 1] = vtx.y; pos[i * 3 + 2] = vtx.z;
        if (vtx.x < min[0]) min[0] = vtx.x; if (vtx.y < min[1]) min[1] = vtx.y; if (vtx.z < min[2]) min[2] = vtx.z;
        if (vtx.x > max[0]) max[0] = vtx.x; if (vtx.y > max[1]) max[1] = vtx.y; if (vtx.z > max[2]) max[2] = vtx.z;
      }
      const attributes = { POSITION: addAccessor(pos, 'VEC3', 5126, n, 34962, { min, max }) };

      if (A.normal) {
        const nor = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          nrm.fromBufferAttribute(A.normal, i);
          const x = NM[0] * nrm.x + NM[4] * nrm.y + NM[8] * nrm.z;
          const y = NM[1] * nrm.x + NM[5] * nrm.y + NM[9] * nrm.z;
          const z = NM[2] * nrm.x + NM[6] * nrm.y + NM[10] * nrm.z;
          const L = Math.hypot(x, y, z) || 1;
          nor[i * 3] = x / L; nor[i * 3 + 1] = y / L; nor[i * 3 + 2] = z / L;
        }
        attributes.NORMAL = addAccessor(nor, 'VEC3', 5126, n, 34962);
      }

      if (A.uv) {
        const uv = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
          let u = A.uv.getX(i), v = A.uv.getY(i);
          if (uvM) { const u2 = uvM[0] * u + uvM[3] * v + uvM[6]; const v2 = uvM[1] * u + uvM[4] * v + uvM[7]; u = u2; v = v2; }
          if (flipY) v = 1 - v;
          uv[i * 2] = u; uv[i * 2 + 1] = v;
        }
        attributes.TEXCOORD_0 = addAccessor(uv, 'VEC2', 5126, n, 34962);
      }

      if (A.color) {
        const col = new Float32Array(n * 4);
        const sz = A.color.itemSize;
        for (let i = 0; i < n; i++) {
          col[i * 4] = A.color.getX(i); col[i * 4 + 1] = A.color.getY(i); col[i * 4 + 2] = A.color.getZ(i);
          col[i * 4 + 3] = sz === 4 ? A.color.getW(i) : 1;
        }
        attributes.COLOR_0 = addAccessor(col, 'VEC4', 5126, n, 34962);
      }

      // Index buffer (generated if the geometry is non-indexed)
      let idx;
      if (g.index) {
        idx = new Uint32Array(g.index.count);
        for (let i = 0; i < g.index.count; i++) idx[i] = g.index.getX(i);
      } else {
        idx = new Uint32Array(n);
        for (let i = 0; i < n; i++) idx[i] = i;
      }
      if (mirrored) for (let i = 0; i + 2 < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
      stlParts.push({ pos, idx });

      const groups = (g.groups && g.groups.length && Array.isArray(mesh.material))
        ? g.groups
        : [{ start: 0, count: idx.length, materialIndex: 0 }];

      const primitives = [];
      for (const grp of groups) {
        const start = grp.start, end = Math.min(idx.length, grp.start + grp.count);
        if (end <= start) continue;
        const sub = idx.subarray(start, end).slice();
        primitives.push({
          attributes: { ...attributes },
          indices: addAccessor(sub, 'SCALAR', 5125, sub.length, 34963),
          material: await toMaterial(mats[grp.materialIndex ?? 0] || mats[0]),
        });
      }
      if (!primitives.length) continue;
      meshesOut.push({ name: mesh.name || undefined, primitives });
      nodes.push({ name: (mesh.name || 'mesh') + (instances > 1 ? '_' + k : ''), mesh: meshesOut.length - 1 });
    }
  }

  if (!nodes.length) {
    if (isTop) toast('Сцена найдена, но мешей с геометрией в ней нет.', false);
    return;
  }

  const download = (bytes, ext, mime) => {
    const name = (location.hostname || 'scene').replace(/[^\w.-]+/g, '_') + '_' + Date.now() + '.' + ext;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: mime }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return name;
  };

  // ---------- STL (binary) ----------
  // three.js is Y-up, slicers are Z-up: (x, y, z) -> (x, -z, y) keeps the model standing.
  if (FORMAT === 'stl') {
    let triTotal = 0;
    for (const p of stlParts) triTotal += Math.floor(p.idx.length / 3);
    const stl = new ArrayBuffer(84 + triTotal * 50);
    const dv = new DataView(stl);
    const header = new TextEncoder().encode('PotehaSTL binary STL');
    new Uint8Array(stl, 0, 80).set(header.subarray(0, 80));
    dv.setUint32(80, triTotal, true);
    let o = 84;
    let minZ = Infinity, maxZ = -Infinity;
    for (const { pos, idx } of stlParts) {
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const v = [];
        for (let j = 0; j < 3; j++) {
          const b = idx[t + j] * 3;
          v.push([pos[b], -pos[b + 2], pos[b + 1]]);
        }
        const ux = v[1][0] - v[0][0], uy = v[1][1] - v[0][1], uz = v[1][2] - v[0][2];
        const wx = v[2][0] - v[0][0], wy = v[2][1] - v[0][1], wz = v[2][2] - v[0][2];
        let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        const L = Math.hypot(nx, ny, nz) || 1;
        dv.setFloat32(o, nx / L, true); dv.setFloat32(o + 4, ny / L, true); dv.setFloat32(o + 8, nz / L, true);
        o += 12;
        for (const p of v) {
          dv.setFloat32(o, p[0], true); dv.setFloat32(o + 4, p[1], true); dv.setFloat32(o + 8, p[2], true);
          o += 12;
          if (p[2] < minZ) minZ = p[2]; if (p[2] > maxZ) maxZ = p[2];
        }
        dv.setUint16(o, 0, true);
        o += 2;
      }
    }
    const name = download(stl, 'stl', 'model/stl');
    toast(
      `Сохранено: ${name}\nТреугольников: ${triTotal.toLocaleString()}, ${(stl.byteLength / 1048576).toFixed(1)} МБ` +
      `\nВысота: ${(maxZ - minZ).toFixed(3)} ед. (слайсер прочитает как мм, масштабируйте под нужный размер)`
    );
    return;
  }

  // ---------- GLB ----------
  const gltf = {
    asset: { version: '2.0', generator: 'PotehaSTL' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes, meshes: meshesOut, materials, accessors, bufferViews,
    buffers: [{ byteLength: 0 }],
  };
  if (images.length) {
    gltf.images = images; gltf.textures = textures;
    gltf.samplers = [{ wrapS: 10497, wrapT: 10497 }];
  }

  const binPad = (4 - (byteLen % 4)) % 4;
  const binLen = byteLen + binPad;
  gltf.buffers[0].byteLength = binLen;

  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPad = (4 - (json.length % 4)) % 4;
  const jsonLen = json.length + jsonPad;
  const total = 12 + 8 + jsonLen + 8 + binLen;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(json, 20);
  out.fill(0x20, 20 + json.length, 20 + jsonLen);
  let o = 20 + jsonLen;
  dv.setUint32(o, binLen, true);
  dv.setUint32(o + 4, 0x004e4942, true); // "BIN\0"
  o += 8;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }

  const name = download(out, 'glb', 'model/gltf-binary');

  const tris = Math.round(accessors.filter((x) => x.type === 'SCALAR').reduce((s, x) => s + x.count, 0) / 3);
  const warnUniq = [...new Set(warnings)];
  toast(
    `Сохранено: ${name}\nМешей: ${nodes.length}, треугольников: ${tris.toLocaleString()}, текстур: ${images.length}, ${(total / 1048576).toFixed(1)} МБ` +
    (warnUniq.length ? '\n⚠ ' + warnUniq.join('\n⚠ ') : '')
  );
})();
