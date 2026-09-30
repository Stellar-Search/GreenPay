/**
 * components/TransactionGraphVisualizer.tsx
 *
 * WebGL visualizer for the Stellar on-chain transaction graph. Nodes are
 * wallet addresses, edges are donations/escrow releases between them.
 *
 * Rendering strategy for scale (up to tens of thousands of nodes):
 *  - Nodes: a single THREE.InstancedMesh (one draw call for all nodes).
 *  - Edges: a single THREE.LineSegments backed by one BufferGeometry (one
 *    draw call for all edges) — cheaper than per-edge instancing for thin
 *    lines and avoids the overhead of tens of thousands of separate draws.
 *  - Picking: at most once per animation frame (raw pointermove events are
 *    coalesced), against a screen-space bucket grid rebuilt a few times a
 *    second as the camera moves. Bucketing by projected screen position
 *    (rather than the camera frustum alone) means a pick only has to test
 *    the handful of nodes near the cursor, not every node currently in
 *    view — so cost tracks cursor locality, not total graph size, even
 *    when zoomed out far enough that the whole graph is on screen.
 *  - Layout: node positions are derived deterministically from a hash of the
 *    wallet address (no full force-directed simulation client-side, which
 *    would not be feasible synchronously at 50k-node scale on the main
 *    thread) — node size still reflects degree so hubs stand out visually.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { NetworkNode, NetworkEdge } from "@/lib/api";
import { shortenAddress, formatXLM } from "@/utils/format";
import { useI18n } from "@/lib/i18n";
import { ScreenBucketGrid } from "@/lib/graphPicking";

interface TransactionGraphVisualizerProps {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
}

interface HoveredNode {
  node: NetworkNode;
  screenX: number;
  screenY: number;
}

const DONATION_COLOR = new THREE.Color("#22c55e");
const ESCROW_COLOR = new THREE.Color("#a855f7");
const NODE_COLOR = new THREE.Color("#15803d");
const HOVER_COLOR = new THREE.Color("#fbbf24");

function hashToUnit(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h / 0xffffffff;
}

/** Deterministic spherical layout, radius grows with hash so the graph isn't a flat shell. */
function layoutNode(id: string): THREE.Vector3 {
  const a = hashToUnit(id);
  const b = hashToUnit(id + ":b");
  const c = hashToUnit(id + ":c");

  const theta = a * Math.PI * 2;
  const phi = Math.acos(2 * b - 1);
  const radius = 20 + c * 180;

  return new THREE.Vector3(
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.sin(phi) * Math.sin(theta),
    radius * Math.cos(phi),
  );
}

export default function TransactionGraphVisualizer({ nodes, edges }: TransactionGraphVisualizerProps) {
  const { localeTag } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<HoveredNode | null>(null);
  const [selected, setSelected] = useState<NetworkNode | null>(null);
  const [query, setQuery] = useState("");

  const normalizedQuery = query.trim().toLowerCase();
  const searchMatches =
    normalizedQuery.length >= 2
      ? nodes.filter((n) => n.id.toLowerCase().includes(normalizedQuery)).slice(0, 8)
      : [];

  useEffect(() => {
    const container = containerRef.current;
    if (!container || nodes.length === 0) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0a0f0a");

    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 5000);
    camera.position.set(0, 0, 400);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 10;
    controls.maxDistance = 2000;

    // ── Build node lookup + positions ──────────────────────────────────────
    const positions = new Float32Array(nodes.length * 3);
    const nodeIndexById = new Map<string, number>();

    nodes.forEach((node, i) => {
      const p = layoutNode(node.id);
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      nodeIndexById.set(node.id, i);
    });

    // ── Nodes: one InstancedMesh, one draw call ────────────────────────────
    const nodeGeometry = new THREE.SphereGeometry(1, 10, 10);
    const nodeMaterial = new THREE.MeshBasicMaterial();
    const nodeMesh = new THREE.InstancedMesh(nodeGeometry, nodeMaterial, nodes.length);
    nodeMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nodes.length * 3), 3);

    const dummy = new THREE.Object3D();
    nodes.forEach((node, i) => {
      const scale = 1 + Math.log2(1 + node.degree) * 0.6;
      dummy.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      dummy.scale.setScalar(Math.min(scale, 6));
      dummy.updateMatrix();
      nodeMesh.setMatrixAt(i, dummy.matrix);
      nodeMesh.setColorAt(i, NODE_COLOR);
    });
    nodeMesh.instanceMatrix.needsUpdate = true;
    if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
    scene.add(nodeMesh);

    // ── Edges: one LineSegments, one draw call ─────────────────────────────
    const edgePositions = new Float32Array(edges.length * 6);
    const edgeColors = new Float32Array(edges.length * 6);
    let edgeVertCount = 0;
    edges.forEach((edge) => {
      const sIdx = nodeIndexById.get(edge.source);
      const tIdx = nodeIndexById.get(edge.target);
      if (sIdx === undefined || tIdx === undefined) return;

      const base = edgeVertCount * 6;
      edgePositions[base] = positions[sIdx * 3];
      edgePositions[base + 1] = positions[sIdx * 3 + 1];
      edgePositions[base + 2] = positions[sIdx * 3 + 2];
      edgePositions[base + 3] = positions[tIdx * 3];
      edgePositions[base + 4] = positions[tIdx * 3 + 1];
      edgePositions[base + 5] = positions[tIdx * 3 + 2];

      const color = edge.type === "escrow" ? ESCROW_COLOR : DONATION_COLOR;
      edgeColors[base] = color.r; edgeColors[base + 1] = color.g; edgeColors[base + 2] = color.b;
      edgeColors[base + 3] = color.r; edgeColors[base + 4] = color.g; edgeColors[base + 5] = color.b;
      edgeVertCount += 1;
    });

    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePositions.subarray(0, edgeVertCount * 6), 3));
    edgeGeometry.setAttribute("color", new THREE.BufferAttribute(edgeColors.subarray(0, edgeVertCount * 6), 3));
    const edgeMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.35 });
    const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    scene.add(edgeLines);

    // ── Interaction: screen-space bucket grid + manual ray/sphere test ─────
    // Rebuilt a few times a second (see frustumCounter below) as the camera
    // moves; queried on every pick. All scratch objects and typed arrays are
    // allocated once here and reused — no per-candidate allocation below.
    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    const frustum = new THREE.Frustum();
    const projScreenMatrix = new THREE.Matrix4();
    const scratchSphere = new THREE.Sphere();
    const scratchVec3 = new THREE.Vector3();
    const scratchHitPoint = new THREE.Vector3();
    let hoveredIndex = -1;

    const screenX = new Float32Array(nodes.length);
    const screenY = new Float32Array(nodes.length);
    const screenNodeIndex = new Int32Array(nodes.length);
    const bucketGrid = new ScreenBucketGrid(nodes.length);
    let visibleCount = 0;

    function recomputeFrustumVisibility() {
      projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projScreenMatrix);

      const canvasWidth = renderer.domElement.clientWidth || 1;
      const canvasHeight = renderer.domElement.clientHeight || 1;

      visibleCount = 0;
      for (let i = 0; i < nodes.length; i++) {
        scratchSphere.center.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
        scratchSphere.radius = 4;
        if (!frustum.intersectsSphere(scratchSphere)) continue;

        scratchVec3.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]).project(camera);
        screenX[visibleCount] = (scratchVec3.x * 0.5 + 0.5) * canvasWidth;
        screenY[visibleCount] = (-scratchVec3.y * 0.5 + 0.5) * canvasHeight;
        screenNodeIndex[visibleCount] = i;
        visibleCount++;
      }

      bucketGrid.rebuild(screenX, screenY, visibleCount, canvasWidth, canvasHeight);
    }

    function setNodeColor(index: number, color: THREE.Color) {
      nodeMesh.setColorAt(index, color);
      if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
    }

    function pickNode(clientX: number, clientY: number): number {
      const rect = renderer.domElement.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      pointerNdc.x = (px / rect.width) * 2 - 1;
      pointerNdc.y = -(py / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNdc, camera);

      const centerCol = bucketGrid.centerCol(px);
      const centerRow = bucketGrid.centerRow(py);

      let closestIndex = -1;
      let closestDist = Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bucket = bucketGrid.boundedBucketIndex(centerCol + dx, centerRow + dy);
          if (bucket === -1) continue;
          const start = bucketGrid.bucketStart[bucket];
          const end = bucketGrid.bucketStart[bucket + 1];
          for (let k = start; k < end; k++) {
            const i = screenNodeIndex[bucketGrid.bucketItems[k]];
            scratchSphere.center.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
            scratchSphere.radius = 3;
            const hit = raycaster.ray.intersectSphere(scratchSphere, scratchHitPoint);
            if (hit) {
              const dist = hit.distanceTo(camera.position);
              if (dist < closestDist) {
                closestDist = dist;
                closestIndex = i;
              }
            }
          }
        }
      }
      return closestIndex;
    }

    function applyPick(index: number, clientX: number, clientY: number) {
      if (index === hoveredIndex) return;

      if (hoveredIndex !== -1) {
        setNodeColor(hoveredIndex, NODE_COLOR);
      }
      hoveredIndex = index;

      if (index === -1) {
        setHovered(null);
        return;
      }
      setNodeColor(index, HOVER_COLOR);
      const rect = renderer.domElement.getBoundingClientRect();
      setHovered({ node: nodes[index], screenX: clientX - rect.left, screenY: clientY - rect.top });
    }

    // Raw pointermove can fire far faster than the display refresh rate
    // (high-poll-rate mice/trackpads). Record only the latest coordinates
    // here and resolve the pick once per animation frame in animate().
    let pendingPickX = 0;
    let pendingPickY = 0;
    let pickPending = false;

    function onPointerMove(e: PointerEvent) {
      pendingPickX = e.clientX;
      pendingPickY = e.clientY;
      pickPending = true;
    }

    function onClick(e: PointerEvent) {
      const index = pickNode(e.clientX, e.clientY);
      setSelected(index === -1 ? null : nodes[index]);
    }

    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("click", onClick);

    function handleResize() {
      const w = container!.clientWidth;
      const h = container!.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    window.addEventListener("resize", handleResize);

    let frameId: number;
    let frustumCounter = 0;
    function animate() {
      frameId = requestAnimationFrame(animate);
      controls.update();
      // Recompute the screen-space bucket grid a few times a second, not every
      // frame — it only needs to track camera movement, not render-loop cadence.
      if (frustumCounter++ % 6 === 0) recomputeFrustumVisibility();
      if (pickPending) {
        pickPending = false;
        applyPick(pickNode(pendingPickX, pendingPickY), pendingPickX, pendingPickY);
      }
      renderer.render(scene, camera);
    }
    recomputeFrustumVisibility();
    animate();

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", handleResize);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("click", onClick);
      controls.dispose();
      nodeGeometry.dispose();
      nodeMaterial.dispose();
      edgeGeometry.dispose();
      edgeMaterial.dispose();
      renderer.dispose();
      // Explicitly release the underlying WebGL context (dispose() frees
      // three.js-tracked GPU resources but keeps the context alive) — without
      // this, repeated mounts of this component leak contexts toward the
      // browser's limit (~16 in Chromium) and eventually fail to render.
      renderer.forceContextLoss();
      container.removeChild(renderer.domElement);
    };
  }, [nodes, edges]);

  return (
    <div className="w-full h-full min-h-[600px] flex flex-col">
      {/* Keyboard-accessible fallback — the canvas below has no accessibility
          affordances of its own (raycasting against a WebGL canvas isn't
          reachable by keyboard or a screen reader), so this search box gives
          non-mouse users an equivalent way to reach node details. */}
      <div className="mb-3">
        <label htmlFor="graph-node-search" className="block text-xs text-forest-300 mb-1">
          Find a wallet without using the mouse
        </label>
        <input
          id="graph-node-search"
          type="text"
          role="combobox"
          aria-expanded={searchMatches.length > 0}
          aria-controls="graph-node-search-results"
          aria-autocomplete="list"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search wallet address…"
          className="w-full max-w-sm px-3 py-2 rounded-lg bg-black/40 border border-forest-700 text-white text-sm placeholder:text-forest-400 focus:outline-none focus:ring-2 focus:ring-forest-400"
        />
        {searchMatches.length > 0 && (
          <ul
            id="graph-node-search-results"
            role="listbox"
            aria-label="Matching wallets"
            className="mt-1 max-w-sm rounded-lg bg-black/90 border border-forest-700 divide-y divide-forest-800 overflow-hidden"
          >
            {searchMatches.map((n) => (
              <li key={n.id} role="option" aria-selected={selected?.id === n.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(n);
                    setQuery("");
                  }}
                  className="w-full text-start px-3 py-2 text-xs font-mono text-white hover:bg-forest-800 focus:bg-forest-800 focus:outline-none"
                >
                  {shortenAddress(n.id, 8)} · {n.degree} connection{n.degree === 1 ? "" : "s"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div ref={containerRef} className="relative w-full flex-1 min-h-[600px]">
        {hovered && (
          <div
            className="absolute z-10 pointer-events-none px-3 py-2 rounded-lg bg-black/80 text-white text-xs font-mono"
            style={{ left: hovered.screenX + 12, top: hovered.screenY + 12 }}
          >
            <div>{shortenAddress(hovered.node.id, 6)}</div>
            <div>In: {formatXLM(hovered.node.totalIn, 2, localeTag)} · Out: {formatXLM(hovered.node.totalOut, 2, localeTag)}</div>
            <div>Connections: {hovered.node.degree}</div>
          </div>
        )}
        {selected && (
          <div
            className="absolute z-10 top-4 end-4 px-4 py-3 rounded-xl bg-white/95 shadow-lg text-sm"
            aria-live="polite"
          >
            <p className="font-mono font-semibold text-forest-900">{shortenAddress(selected.id, 8)}</p>
            <p className="text-forest-600 mt-1">Total in: {formatXLM(selected.totalIn, 2, localeTag)}</p>
            <p className="text-forest-600">Total out: {formatXLM(selected.totalOut, 2, localeTag)}</p>
            <p className="text-forest-600">Connections: {selected.degree}</p>
          </div>
        )}
      </div>
    </div>
  );
}
