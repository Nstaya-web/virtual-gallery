/* Virtual gallery — places artworks onto frames and wires click → info panel. */

(function () {
  "use strict";

  const APERTURE_FACTOR = 0.78;       // shrink of bbox to estimate inner "window"
  const FORWARD_OFFSET  = 0.15;       // metres in front of frame face — larger value avoids
                                      // Z-fighting with the frame's own baked-in poster texture
                                      // when viewed from far across the large gallery
  const MAX_PLACEMENT_TIMEOUT = 15000;

  const $ = (sel) => document.querySelector(sel);

  // ---------- Info panel ----------
  const panelEl = $("#info-panel");
  const panelTitle = $("#panel-title");
  const panelText  = $("#panel-text");

  function showPanel(work) {
    panelTitle.textContent = work.TITLE || work.ID;
    panelText.textContent  = work.TEXT  || "";
    panelEl.classList.remove("hidden");
    panelEl.setAttribute("aria-hidden", "false");
  }
  function hidePanel() {
    panelEl.classList.add("hidden");
    panelEl.setAttribute("aria-hidden", "true");
    // Return focus to body so A-Frame's wasd-controls/look-controls receive keypresses again.
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
  }
  $("#panel-close").addEventListener("click", hidePanel);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hidePanel();
  });

  // ---------- Config + model bootstrap ----------
  const roomEl    = $("#room-entity");
  const worksEl   = $("#artworks");
  const loaderEl  = $("#hud-loader");

  const worksByFrame = new Map();   // frame name → work object

  fetch("config/config.json")
    .then((r) => {
      if (!r.ok) throw new Error("config.json HTTP " + r.status);
      return r.json();
    })
    .then((config) => {
      window.__GALLERY_CONFIG__ = config;
      for (const w of config.WORKS) worksByFrame.set(w.FRAME, w);

      if (roomEl.hasLoaded && roomEl.getObject3D("mesh")) {
        placeAllArtworks(config);
      } else {
        roomEl.addEventListener("model-loaded", () => placeAllArtworks(config), { once: true });
      }

      // Safety timeout in case model never fires the event
      setTimeout(() => {
        if (loaderEl && !loaderEl.classList.contains("hidden")) {
          loaderEl.textContent = "Не вдалося завантажити модель. Перевірте консоль.";
        }
      }, MAX_PLACEMENT_TIMEOUT);
    })
    .catch((err) => {
      console.error("[gallery] config load failed:", err);
      if (loaderEl) loaderEl.textContent = "Помилка завантаження config.json";
    });

  // ---------- Placement ----------
  function placeAllArtworks(config) {
    const root = roomEl.getObject3D("mesh");
    if (!root) {
      console.error("[gallery] room model has no mesh root");
      return;
    }

    // Collect frame Object3Ds by name from the model
    const frames = {};
    root.traverse((obj) => {
      if (obj.name && /^FRM_\d{2}$/.test(obj.name)) {
        frames[obj.name] = obj;
      }
    });

    // Compute scene-wide bbox — used as a "room volume" for frame-orientation heuristics
    const roomBox = new THREE.Box3().setFromObject(root);
    const roomCenter = roomBox.getCenter(new THREE.Vector3());

    let placed = 0;
    for (const work of config.WORKS) {
      const frameObj = frames[work.FRAME];
      if (!frameObj) {
        console.warn(`[gallery] frame ${work.FRAME} not found in model`);
        continue;
      }
      try {
        placeArtwork(work, frameObj, roomCenter, roomBox);
        placed++;
      } catch (e) {
        console.error(`[gallery] failed to place ${work.ID}:`, e);
      }
    }

    if (loaderEl) loaderEl.classList.add("hidden");
    console.log(`[gallery] placed ${placed} / ${config.WORKS.length} works`);
  }

  function placeArtwork(work, frameObj, roomCenter, roomBox) {
    // World-space bounding box of the frame
    const box = new THREE.Box3().setFromObject(frameObj);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    // Forward direction = the frame's own local +Y axis transformed to world space.
    // This Blender export uses local +Y as the frame's face normal for partition-wall frames.
    const worldQuat = new THREE.Quaternion();
    frameObj.getWorldQuaternion(worldQuat);
    let forward = new THREE.Vector3(0, 1, 0).applyQuaternion(worldQuat).normalize();

    // Sanity check 1: forward should be roughly horizontal (frames hang on vertical walls).
    if (Math.abs(forward.y) > 0.7) {
      const toRoom = new THREE.Vector3().subVectors(roomCenter, center);
      const absX = Math.abs(toRoom.x), absZ = Math.abs(toRoom.z);
      forward.set(0, 0, 0);
      if (absX >= absZ) forward.x = Math.sign(toRoom.x) || 1;
      else              forward.z = Math.sign(toRoom.z) || 1;
    }

    // Sanity check 2: if the frame is much closer to one room boundary than the other along
    // its forward axis, the "front" must face away from that boundary. This catches frames
    // mounted on perimeter walls whose mesh orientation points into the wall.
    const dominantAxis = Math.abs(forward.x) > Math.abs(forward.z) ? "x" : "z";
    const distMinSide = center[dominantAxis] - roomBox.min[dominantAxis];
    const distMaxSide = roomBox.max[dominantAxis] - center[dominantAxis];
    const ratio = Math.max(distMinSide, distMaxSide) / Math.max(0.01, Math.min(distMinSide, distMaxSide));
    if (ratio > 4) {
      // Strongly asymmetric — frame is near a perimeter wall. Forward should point toward open side.
      const correctSign = distMaxSide > distMinSide ? 1 : -1;
      const newForward = new THREE.Vector3(0, 0, 0);
      newForward[dominantAxis] = correctSign;
      // Only override if the heuristic disagrees with current forward
      if (Math.sign(forward[dominantAxis]) !== correctSign) {
        forward = newForward;
      }
    }

    // Aperture (width/height of the frame's "window") — derived from world bbox using
    // axes perpendicular to forward. Y is always vertical for wall-hung frames.
    const horizontalAxis = Math.abs(forward.x) > Math.abs(forward.z) ? "z" : "x";
    const Wap = size[horizontalAxis] * APERTURE_FACTOR;
    const Hap = size.y * APERTURE_FACTOR;

    // Half-depth along forward direction
    const halfDepth = (Math.abs(forward.x) * size.x + Math.abs(forward.z) * size.z) * 0.5;
    const planePos = center.clone().addScaledVector(forward, halfDepth + FORWARD_OFFSET);
    const lookTarget = planePos.clone().add(forward);

    // Build A-Frame entity. Use <a-image> for textured planes; A-Frame handles material.
    const entity = document.createElement("a-image");
    entity.setAttribute("src", `#img-${work.ID.toLowerCase()}`);
    entity.setAttribute("position", `${planePos.x} ${planePos.y} ${planePos.z}`);
    entity.setAttribute("data-work-id", work.ID);
    entity.classList.add("clickable");
    // Use double-sided so we don't worry about facing
    entity.setAttribute("material", "shader: flat; side: double; transparent: false");

    // Set placeholder size; corrected once the texture is loaded so we know aspect
    entity.setAttribute("width", Wap);
    entity.setAttribute("height", Hap);

    // Apply orientation via lookAt once it's in the scene
    entity.addEventListener("loaded", () => {
      const obj = entity.object3D;
      obj.lookAt(lookTarget);
    });

    // Improve texture sampling at distance (mipmaps + anisotropy) — fixes black artifacts
    // when artwork is viewed from far away or at oblique angles.
    entity.addEventListener("materialtextureloaded", (evt) => {
      const tex = evt.detail && evt.detail.texture;
      const mesh = entity.getObject3D("mesh");
      const map = (tex || (mesh && mesh.material && mesh.material.map));
      if (!map) return;
      const renderer = entity.sceneEl && entity.sceneEl.renderer;
      const maxAniso = renderer ? renderer.capabilities.getMaxAnisotropy() : 16;
      map.anisotropy = maxAniso;
      map.minFilter = THREE.LinearMipmapLinearFilter;
      map.magFilter = THREE.LinearFilter;
      map.generateMipmaps = true;
      map.needsUpdate = true;
    });

    // Once the image asset is ready, recompute CONTAIN dims using actual aspect ratio
    const imgEl = document.getElementById(`img-${work.ID.toLowerCase()}`);
    const applyContain = () => {
      const iw = imgEl.naturalWidth || imgEl.width;
      const ih = imgEl.naturalHeight || imgEl.height;
      if (!iw || !ih) return;
      const Aimg = iw / ih;
      const Aap  = Wap / Hap;
      let W, H;
      if (Aimg >= Aap) {
        W = Wap;
        H = Wap / Aimg;
      } else {
        H = Hap;
        W = Hap * Aimg;
      }
      entity.setAttribute("width", W);
      entity.setAttribute("height", H);
    };
    if (imgEl.complete && imgEl.naturalWidth) {
      applyContain();
    } else {
      imgEl.addEventListener("load", applyContain, { once: true });
    }

    // Click → panel
    entity.addEventListener("click", () => {
      const id = entity.getAttribute("data-work-id");
      const work = (window.__GALLERY_CONFIG__.WORKS || []).find((w) => w.ID === id);
      if (work) showPanel(work);
    });

    worksEl.appendChild(entity);
  }
})();
