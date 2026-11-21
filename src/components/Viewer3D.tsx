import { useEffect, useRef, useState } from "react";
import { Divider, IconButton, Paper, Stack, Tooltip } from "@mui/material";
import {
  Box,
  ScanBox,
  Grid3x3,
  Cookie,
  PawPrint,
  Slice,
  Frame,
  Sparkles,
  Sun,
  RefreshCw,
  Stamp,
  // Aperture, // SSAO (hidden for now)
  // ImageDown, // preview export (hidden for now)
} from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import {
  loadCookieEdgeHighlights,
  loadEdgeHighlights,
  loadHighlightTip,
  loadOrthographic,
  loadShowCookie,
  loadWireframe,
  saveCookieEdgeHighlights,
  saveEdgeHighlights,
  saveHighlightTip,
  saveOrthographic,
  saveShowCookie,
  saveWireframe,
} from "../storage";

type Props = {
  group: THREE.Group | null;
  liveUpdate: boolean;
  /** Pending sketch/param changes not yet applied to the 3D view. */
  needsApply: boolean;
  onLiveUpdateChange: (v: boolean) => void;
  onApply: () => void;
};

type SceneCtx = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  persp: THREE.PerspectiveCamera;
  ortho: THREE.OrthographicCamera;
  controls: OrbitControls;
  root: THREE.Group;
  hemi: THREE.HemisphereLight;
  keyLight: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  rim: THREE.DirectionalLight;
  composer: EffectComposer;
  renderPass: RenderPass;
  ssaoPass: SSAOPass;
  frame: number;
  framed: boolean;
  orthographic: boolean;
  frustumSize: number;
  ssao: boolean;
};

const FRUSTUM = 100;
const BODY_COLOR = 0xe8d5b7;
/** Hot signal color so the tip reads clearly on the dough-colored body. */
const TIP_COLOR = 0xff1744;
const TIP_EMISSIVE = 0xff5722;
/** Crease angle (°) for CAD-style hard-edge overlay. */
const EDGE_THRESHOLD = 20;
const EDGE_COLOR = 0x3d2c1e;

const LIGHT_BASE = {
  hemi: 0.85,
  key: 1.15,
  fill: 0.35,
  rim: 0.3,
} as const;
const LIGHT_STRONG = {
  hemi: 0.55,
  key: 1.75,
  fill: 0.55,
  rim: 0.55,
} as const;

const lucideBtnSx = { width: 34, height: 34 };

function LucideIcon({
  Icon,
  active,
}: {
  Icon: typeof ScanBox;
  active?: boolean;
}) {
  return (
    <Icon
      size={18}
      strokeWidth={2}
      color={active ? "currentColor" : undefined}
    />
  );
}

function applyKnifeTipHighlight(root: THREE.Object3D, on: boolean) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.userData.knifeTip || mesh.userData.edgeOverlay)
      return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (!mat?.color) return;
    if (on) {
      mat.color.setHex(TIP_COLOR);
      mat.emissive.setHex(TIP_EMISSIVE);
      mat.emissiveIntensity = 1.35;
      mat.metalness = 0.15;
      mat.roughness = 0.35;
    } else {
      mat.color.setHex(BODY_COLOR);
      mat.emissive.setHex(0x000000);
      mat.emissiveIntensity = 0;
      const shiny = !!mesh.userData.viewerShiny;
      mat.metalness = shiny ? 0.28 : 0.05;
      mat.roughness = shiny ? 0.28 : 0.55;
    }
  });
}

function applyPartVisibility(
  root: THREE.Object3D,
  cutter: boolean,
  stamp: boolean,
  cookie: boolean,
) {
  root.traverse((o) => {
    // Edge overlays follow their parent mesh; leave their own .visible to
    // applyEdgeHighlights so mode switches do not force edges back on.
    if (o.userData.edgeOverlay) return;
    if (o.userData.part === "cutter") o.visible = !cookie && cutter;
    if (o.userData.part === "stamp") o.visible = !cookie && stamp;
    if (o.userData.part === "cookie") o.visible = cookie;
  });
}

function applyWireframe(root: THREE.Object3D, on: boolean, edgesOn: boolean) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.edgeOverlay) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (mat && "wireframe" in mat) mat.wireframe = on;
    for (const child of mesh.children) {
      if (child.userData.edgeOverlay) child.visible = edgesOn && !on;
    }
  });
}

function applyEdgeHighlights(root: THREE.Object3D, on: boolean, wireframe: boolean) {
  root.traverse((o) => {
    if (!o.userData.edgeOverlay) return;
    o.visible = on && !wireframe;
  });
}

/** Viewer-local PBR tweak (materials are cloned for the viewer). */
function applyShinierPbr(root: THREE.Object3D, on: boolean, tipOn: boolean) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.edgeOverlay) return;
    mesh.userData.viewerShiny = on;
    if (mesh.userData.knifeTip && tipOn) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (!mat || !("roughness" in mat)) return;
    if (on) {
      mat.metalness = Math.max(mat.metalness, 0.22);
      mat.roughness = Math.min(mat.roughness, 0.3);
    } else {
      const baseM = mesh.userData.baseMetalness as number | undefined;
      const baseR = mesh.userData.baseRoughness as number | undefined;
      if (baseM != null) mat.metalness = baseM;
      if (baseR != null) mat.roughness = baseR;
    }
  });
}

function applyStrongLighting(
  ctx: Pick<SceneCtx, "hemi" | "keyLight" | "fill" | "rim">,
  on: boolean,
) {
  const L = on ? LIGHT_STRONG : LIGHT_BASE;
  ctx.hemi.intensity = L.hemi;
  ctx.keyLight.intensity = L.key;
  ctx.fill.intensity = L.fill;
  ctx.rim.intensity = L.rim;
}

/** Clone materials so viewer toggles never mutate the App export meshes. */
function localizeViewerMaterials(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.edgeOverlay) return;
    const mat = mesh.material as THREE.Material;
    if (!mat) return;
    const cloned = mat.clone();
    mesh.material = cloned;
    if (cloned instanceof THREE.MeshStandardMaterial) {
      mesh.userData.baseMetalness = cloned.metalness;
      mesh.userData.baseRoughness = cloned.roughness;
    }
  });
}

/** CAD-style crease lines — cheap and makes flat walls readable. */
function attachHardEdges(root: THREE.Object3D, visible: boolean) {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.edgeOverlay) return;
    meshes.push(mesh);
  });
  for (const mesh of meshes) {
    if (!mesh.geometry) continue;
    const edges = new THREE.EdgesGeometry(mesh.geometry, EDGE_THRESHOLD);
    const lines = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({
        color: EDGE_COLOR,
        transparent: true,
        opacity: 0.88,
        depthTest: true,
      }),
    );
    lines.userData.edgeOverlay = true;
    lines.userData.part = mesh.userData.part;
    lines.renderOrder = 1;
    lines.visible = visible;
    mesh.add(lines);
  }
}

function disposeViewerObject(root: THREE.Object3D) {
  root.traverse((o) => {
    if (o.userData.edgeOverlay) {
      const line = o as THREE.LineSegments;
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
      return;
    }
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.material) {
      // Viewer-local clones only
      const mat = mesh.material as THREE.Material;
      if (mesh.userData.baseMetalness != null) mat.dispose();
    }
  });
}

export function Viewer3D({
  group,
  liveUpdate,
  needsApply,
  onLiveUpdateChange,
  onApply,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneCtx | null>(null);
  const [orthographic, setOrthographic] = useState(() => loadOrthographic());
  const [highlightTip, setHighlightTip] = useState(() => loadHighlightTip());
  const [wireframe, setWireframe] = useState(() => loadWireframe());
  const [edgeHighlights, setEdgeHighlights] = useState(() => loadEdgeHighlights());
  const [cookieEdgeHighlights, setCookieEdgeHighlights] = useState(() =>
    loadCookieEdgeHighlights(),
  );
  const [shinierPbr, setShinierPbr] = useState(false);
  const [strongLight, setStrongLight] = useState(false);
  const [ssao] = useState(false); // toggle UI hidden for now
  const [showCutter, setShowCutter] = useState(true);
  const [showStamp, setShowStamp] = useState(true);
  const [showCookie, setShowCookie] = useState(() => loadShowCookie());
  const activeEdgeHighlights = showCookie ? cookieEdgeHighlights : edgeHighlights;

  const highlightTipRef = useRef(highlightTip);
  highlightTipRef.current = highlightTip;
  const wireframeRef = useRef(wireframe);
  wireframeRef.current = wireframe;
  const edgesRef = useRef(activeEdgeHighlights);
  edgesRef.current = activeEdgeHighlights;
  const shinyRef = useRef(shinierPbr);
  shinyRef.current = shinierPbr;

  useEffect(() => {
    saveOrthographic(orthographic);
  }, [orthographic]);

  useEffect(() => {
    saveHighlightTip(highlightTip);
  }, [highlightTip]);

  useEffect(() => {
    saveWireframe(wireframe);
  }, [wireframe]);

  useEffect(() => {
    saveShowCookie(showCookie);
  }, [showCookie]);

  useEffect(() => {
    saveEdgeHighlights(edgeHighlights);
  }, [edgeHighlights]);

  useEffect(() => {
    saveCookieEdgeHighlights(cookieEdgeHighlights);
  }, [cookieEdgeHighlights]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf0f2f5);

    const persp = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
    persp.position.set(60, -80, 70);
    persp.up.set(0, 0, 1);

    const ortho = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 2000);
    ortho.position.copy(persp.position);
    ortho.up.copy(persp.up);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      // Needed so export can read pixels after the last frame
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    mount.appendChild(renderer.domElement);

    const startOrtho = loadOrthographic();
    const controls = new OrbitControls(
      startOrtho ? ortho : persp,
      renderer.domElement,
    );
    controls.enableDamping = true;
    controls.screenSpacePanning = true;
    controls.target.set(0, 0, 8);

    const hemi = new THREE.HemisphereLight(0xfff6ec, 0x8a9bb0, LIGHT_BASE.hemi);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, LIGHT_BASE.key);
    key.position.set(55, -45, 90);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xdde7ff, LIGHT_BASE.fill);
    fill.position.set(-50, 55, 40);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xfff0e0, LIGHT_BASE.rim);
    rim.position.set(-20, -60, 50);
    scene.add(rim);

    const root = new THREE.Group();
    scene.add(root);

    const grid = new THREE.GridHelper(120, 24, 0xcccccc, 0xe8e8e8);
    grid.rotation.x = Math.PI / 2;
    scene.add(grid);

    const startCam = startOrtho ? ortho : persp;
    const composer = new EffectComposer(renderer);
    const renderPass = new RenderPass(scene, startCam);
    composer.addPass(renderPass);
    const ssaoPass = new SSAOPass(scene, startCam, 512, 512);
    ssaoPass.kernelRadius = 12;
    ssaoPass.minDistance = 0.001;
    ssaoPass.maxDistance = 0.12;
    composer.addPass(ssaoPass);
    composer.addPass(new OutputPass());

    const syncOrthoFrustum = (w: number, h: number) => {
      const aspect = w / h;
      const halfH = (sceneRef.current?.frustumSize ?? FRUSTUM) / 2;
      ortho.left = -halfH * aspect;
      ortho.right = halfH * aspect;
      ortho.top = halfH;
      ortho.bottom = -halfH;
      ortho.updateProjectionMatrix();
    };

    const activeCamera = () =>
      sceneRef.current?.orthographic ? ortho : persp;

    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w < 2 || h < 2) return;
      persp.aspect = w / h;
      persp.updateProjectionMatrix();
      syncOrthoFrustum(w, h);
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      ssaoPass.setSize(w, h);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
    };
    resize();

    const ro = new ResizeObserver(() => resize());
    ro.observe(mount);
    window.addEventListener("resize", resize);

    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      controls.update();
      const cam = activeCamera();
      if (sceneRef.current?.ssao) {
        renderPass.camera = cam;
        ssaoPass.camera = cam;
        composer.render();
      } else {
        renderer.render(scene, cam);
      }
    };
    tick();

    sceneRef.current = {
      renderer,
      scene,
      persp,
      ortho,
      controls,
      root,
      hemi,
      keyLight: key,
      fill,
      rim,
      composer,
      renderPass,
      ssaoPass,
      frame,
      framed: false,
      orthographic: startOrtho,
      frustumSize: FRUSTUM,
      ssao: false,
    };

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener("resize", resize);
      controls.dispose();
      composer.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) {
        mount.removeChild(renderer.domElement);
      }
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx) return;
    ctx.orthographic = orthographic;
    const cam = orthographic ? ctx.ortho : ctx.persp;
    cam.position.copy(ctx.controls.object.position);
    cam.up.copy(ctx.controls.object.up);
    cam.lookAt(ctx.controls.target);
    ctx.controls.object = cam;
    ctx.controls.update();
    ctx.renderPass.camera = cam;
    ctx.ssaoPass.camera = cam;
  }, [orthographic]);

  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx) return;
    while (ctx.root.children.length) {
      const child = ctx.root.children[0];
      ctx.root.remove(child);
      disposeViewerObject(child);
    }
    if (!group) {
      ctx.framed = false;
      return;
    }
    const clone = group.clone(true);
    localizeViewerMaterials(clone);
    attachHardEdges(clone, edgesRef.current && !wireframeRef.current);
    ctx.root.add(clone);
    applyShinierPbr(clone, shinyRef.current, highlightTipRef.current);
    applyKnifeTipHighlight(clone, highlightTipRef.current);
    applyWireframe(clone, wireframeRef.current, edgesRef.current);
    // Frame only the first time a mesh appears — sketch edits keep the camera
    if (!ctx.framed) {
      const box = new THREE.Box3().setFromObject(ctx.root);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      ctx.controls.target.copy(center);
      const span = Math.max(size.x, size.y, size.z, 20);
      const pos = new THREE.Vector3(
        center.x + span * 0.9,
        center.y - span * 1.1,
        center.z + span * 0.8,
      );
      ctx.persp.up.set(0, 0, 1);
      ctx.ortho.up.set(0, 0, 1);
      ctx.persp.position.copy(pos);
      ctx.ortho.position.copy(pos);
      ctx.persp.lookAt(center);
      ctx.ortho.lookAt(center);
      ctx.frustumSize = Math.max(span * 2.4, 40);
      ctx.ortho.zoom = 1;
      const mount = mountRef.current;
      if (mount && mount.clientHeight > 1) {
        const aspect = mount.clientWidth / mount.clientHeight;
        const halfH = ctx.frustumSize / 2;
        ctx.ortho.left = -halfH * aspect;
        ctx.ortho.right = halfH * aspect;
        ctx.ortho.top = halfH;
        ctx.ortho.bottom = -halfH;
        ctx.ortho.updateProjectionMatrix();
      }
      ctx.framed = true;
    }
  }, [group]);

  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx) return;
    applyPartVisibility(ctx.root, showCutter, showStamp, showCookie);
  }, [showCutter, showStamp, showCookie, group]);

  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx) return;
    applyKnifeTipHighlight(ctx.root, highlightTip);
  }, [highlightTip]);

  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx) return;
    applyWireframe(ctx.root, wireframe, activeEdgeHighlights);
  }, [wireframe, activeEdgeHighlights]);

  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx) return;
    applyEdgeHighlights(ctx.root, activeEdgeHighlights, wireframe);
  }, [activeEdgeHighlights, wireframe, group]);

  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx) return;
    applyShinierPbr(ctx.root, shinierPbr, highlightTip);
  }, [shinierPbr, highlightTip, group]);

  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx) return;
    applyStrongLighting(ctx, strongLight);
  }, [strongLight]);

  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx) return;
    ctx.ssao = ssao;
  }, [ssao]);

  return (
    <div
      ref={mountRef}
      style={{
        width: "100%",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        position: "relative",
      }}
    >
      <Paper
        elevation={2}
        sx={{
          position: "absolute",
          top: 8,
          left: 8,
          zIndex: 2,
          p: 0.35,
          borderRadius: 1.5,
          bgcolor: "rgba(255,255,255,0.94)",
        }}
      >
        <Stack spacing={0.15}>
          <Tooltip
            title={
              showCookie
                ? "Show the cutter and stamp"
                : "Show the resulting cookie"
            }
            placement="right"
          >
            <IconButton
              size="small"
              color={showCookie ? "primary" : "default"}
              onClick={() => setShowCookie((v) => !v)}
              aria-label="Toggle resulting cookie"
              sx={lucideBtnSx}
            >
              <LucideIcon Icon={Cookie} active={showCookie} />
            </IconButton>
          </Tooltip>
          <Divider
            flexItem
            sx={{ width: 28, alignSelf: "center", borderColor: "divider", my: 0.35 }}
          />
          <Tooltip
            title={
              showCookie
                ? "Unavailable in cookie view"
                : showCutter
                  ? "Hide cutter"
                  : "Show cutter"
            }
            placement="right"
          >
            <span>
              <IconButton
                size="small"
                disabled={showCookie}
                color={showCutter && !showCookie ? "primary" : "default"}
                onClick={() => setShowCutter((v) => !v)}
                aria-label="Toggle cutter"
                sx={lucideBtnSx}
              >
                <LucideIcon Icon={PawPrint} active={showCutter && !showCookie} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip
            title={
              showCookie
                ? "Unavailable in cookie view"
                : showStamp
                  ? "Hide stamp"
                  : "Show stamp"
            }
            placement="right"
          >
            <span>
              <IconButton
                size="small"
                disabled={showCookie}
                color={showStamp && !showCookie ? "primary" : "default"}
                onClick={() => setShowStamp((v) => !v)}
                aria-label="Toggle stamp"
                sx={lucideBtnSx}
              >
                <LucideIcon Icon={Stamp} active={showStamp && !showCookie} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip
            title={
              showCookie
                ? "Unavailable in cookie view"
                : highlightTip
                  ? "Hide cutting edge"
                  : "Highlight cutting edge"
            }
            placement="right"
          >
            <span>
              <IconButton
                size="small"
                disabled={showCookie}
                color={highlightTip && !showCookie ? "primary" : "default"}
                onClick={() => setHighlightTip((v) => !v)}
                aria-label="Toggle cutting edge highlight"
                sx={lucideBtnSx}
              >
                <LucideIcon Icon={Slice} active={highlightTip && !showCookie} />
              </IconButton>
            </span>
          </Tooltip>
          <Divider
            flexItem
            sx={{ width: 28, alignSelf: "center", borderColor: "divider", my: 0.35 }}
          />
          <Tooltip
            title={orthographic ? "Perspective view" : "Orthographic view"}
            placement="right"
          >
            <IconButton
              size="small"
              color={orthographic ? "primary" : "default"}
              onClick={() => setOrthographic((v) => !v)}
              aria-label="Toggle orthographic"
              sx={lucideBtnSx}
            >
              <LucideIcon
                Icon={orthographic ? ScanBox : Box}
                active={orthographic}
              />
            </IconButton>
          </Tooltip>
          <Tooltip
            title={wireframe ? "Solid shading" : "Mesh view"}
            placement="right"
          >
            <IconButton
              size="small"
              color={wireframe ? "primary" : "default"}
              onClick={() => setWireframe((v) => !v)}
              aria-label="Toggle mesh view"
              sx={lucideBtnSx}
            >
              <LucideIcon Icon={Grid3x3} active={wireframe} />
            </IconButton>
          </Tooltip>
          <Tooltip
            title={
              activeEdgeHighlights
                ? "Hide edge highlights"
                : "Show edge highlights"
            }
            placement="right"
          >
            <IconButton
              size="small"
              color={activeEdgeHighlights ? "primary" : "default"}
              onClick={() =>
                showCookie
                  ? setCookieEdgeHighlights((v) => !v)
                  : setEdgeHighlights((v) => !v)
              }
              aria-label="Toggle edge highlights"
              sx={lucideBtnSx}
            >
              <LucideIcon Icon={Frame} active={activeEdgeHighlights} />
            </IconButton>
          </Tooltip>
          <Tooltip
            title={shinierPbr ? "Matte material" : "Shinier material"}
            placement="right"
          >
            <IconButton
              size="small"
              color={shinierPbr ? "primary" : "default"}
              onClick={() => setShinierPbr((v) => !v)}
              aria-label="Toggle shinier material"
              sx={lucideBtnSx}
            >
              <LucideIcon Icon={Sparkles} active={shinierPbr} />
            </IconButton>
          </Tooltip>
          <Tooltip
            title={strongLight ? "Softer lighting" : "Stronger lighting"}
            placement="right"
          >
            <IconButton
              size="small"
              color={strongLight ? "primary" : "default"}
              onClick={() => setStrongLight((v) => !v)}
              aria-label="Toggle stronger lighting"
              sx={lucideBtnSx}
            >
              <LucideIcon Icon={Sun} active={strongLight} />
            </IconButton>
          </Tooltip>
          {/* SSAO — hidden for now
          <Tooltip title={ssao ? "Disable SSAO" : "Enable SSAO"} placement="right">
            <IconButton
              size="small"
              color={ssao ? "primary" : "default"}
              onClick={() => setSsao((v) => !v)}
              aria-label="Toggle SSAO"
              sx={lucideBtnSx}
            >
              <LucideIcon Icon={Aperture} active={ssao} />
            </IconButton>
          </Tooltip>
          */}
          <Divider
            flexItem
            sx={{ width: 28, alignSelf: "center", borderColor: "divider", my: 0.35 }}
          />
          <Tooltip
            title={
              liveUpdate
                ? "Live 3D update on"
                : needsApply
                  ? "Apply to 3D view"
                  : "Live 3D update off"
            }
            placement="right"
          >
            <IconButton
              size="small"
              color={liveUpdate || needsApply ? "primary" : "default"}
              onClick={() => {
                if (liveUpdate) onLiveUpdateChange(false);
                else if (needsApply) onApply();
                else onLiveUpdateChange(true);
              }}
              aria-label="Live 3D update"
              sx={lucideBtnSx}
            >
              <LucideIcon Icon={RefreshCw} active={liveUpdate || needsApply} />
            </IconButton>
          </Tooltip>
        </Stack>
      </Paper>
    </div>
  );
}
