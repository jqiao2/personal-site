// The taste space on /films/stats: watched films as points in a 3D genre ×
// popularity space, inside a fog that is warm where the ratings run high and
// cool where they run low. Drawn only when the view changes — nothing moves on
// its own.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { tasteField, type TastePoint } from '../lib/film-taste';
import { starText } from '../lib/format';

const LOW = new THREE.Color('#5e9fd8');

const MID = new THREE.Color('#8a6f63');

const HIGH = new THREE.Color('#d9b45a');

const UNRATED = new THREE.Color('#5a4440');

// Diverging around the owner's own average: a whole star either side is full colour.
function ratingColor(r: number, avg: number, out = new THREE.Color()): THREE.Color {
	const t = Math.max(-1, Math.min(1, r - avg));

	return out.copy(MID).lerp(t > 0 ? HIGH : LOW, Math.abs(t));
}

const VERT = /* glsl */ `
	attribute vec3 tint;
	attribute float alpha;
	uniform float uSize;
	uniform float uScale;
	varying vec3 vTint;
	varying float vAlpha;
	void main() {
		vec4 mv = modelViewMatrix * vec4(position, 1.0);
		gl_PointSize = uSize * uScale / -mv.z;
		gl_Position = projectionMatrix * mv;
		vTint = tint;
		vAlpha = alpha;
	}
`;

// Soft Gaussian puff for the fog.
const FOG_FRAG = /* glsl */ `
	varying vec3 vTint;
	varying float vAlpha;
	void main() {
		float d = length(gl_PointCoord - 0.5) * 2.0;
		if (d > 1.0) discard;
		gl_FragColor = vec4(vTint, vAlpha * exp(-d * d * 3.0));
	}
`;

// Solid disc with a dark rim, so neighbouring films stay separable.
const DOT_FRAG = /* glsl */ `
	varying vec3 vTint;
	varying float vAlpha;
	void main() {
		float d = length(gl_PointCoord - 0.5) * 2.0;
		if (d > 1.0) discard;
		gl_FragColor = vec4(d > 0.72 ? vTint * 0.35 : vTint, vAlpha);
	}
`;

function pointCloud(positions: Float32Array, tints: Float32Array, alphas: Float32Array, size: number, frag: string) {
	const geo = new THREE.BufferGeometry();
	geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	geo.setAttribute('tint', new THREE.BufferAttribute(tints, 3));
	geo.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));

	const mat = new THREE.ShaderMaterial({
		vertexShader: VERT,
		fragmentShader: frag,
		uniforms: { uSize: { value: size }, uScale: { value: 1 } },
		transparent: true,
		depthWrite: frag === DOT_FRAG,
	});

	return new THREE.Points(geo, mat);
}

const AXES: [string, [number, number, number]][] = [
	['Light', [-1.18, 0, 0]],
	['Dark', [1.18, 0, 0]],
	['Grounded', [0, -1.14, 0]],
	['Fantastical', [0, 1.14, 0]],
	['Calm', [0, 0, -1.18]],
	['Intense', [0, 0, 1.18]],
];

export function mountTasteSpace(stage: HTMLElement): void {
	const points: TastePoint[] = JSON.parse(stage.querySelector('[data-taste-points]')?.textContent ?? '[]');
	const avg = Number(stage.dataset.avg);
	const tip = stage.querySelector<HTMLAnchorElement>('.taste__tip');

	if (!tip) return;

	const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
	renderer.setPixelRatio(window.devicePixelRatio);
	stage.prepend(renderer.domElement);

	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 50);
	camera.position.set(3.1, 2, 3.8);

	const controls = new OrbitControls(camera, renderer.domElement);
	controls.zoomToCursor = true;
	controls.minDistance = 0.4;
	controls.maxDistance = 12;

	scene.add(
		new THREE.LineSegments(
			new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)),
			new THREE.LineBasicMaterial({ color: '#4a2529' }),
		),
	);

	// The rating fog.
	const field = tasteField(points);
	const fogTint = new Float32Array(field.ratings.length * 3);
	const fogAlpha = new Float32Array(field.ratings.length);
	const c = new THREE.Color();

	for (let i = 0; i < field.ratings.length; i++) {
		ratingColor(field.ratings[i], avg, c).toArray(fogTint, i * 3);
		// Neutral regions stay faint; strong likes and dislikes read through.
		const lean = Math.min(1, Math.abs(field.ratings[i] - avg));
		fogAlpha[i] = Math.sqrt(field.density[i]) * (0.05 + 0.3 * lean);
	}

	const fog = pointCloud(field.positions, fogTint, fogAlpha, 0.32, FOG_FRAG);
	fog.renderOrder = 1;
	scene.add(fog);

	// The films.
	const pos = new Float32Array(points.length * 3);
	const tint = new Float32Array(points.length * 3);
	const alpha = new Float32Array(points.length).fill(1);

	points.forEach((p, i) => {
		pos.set(p.p, i * 3);
		(p.r == null ? UNRATED : ratingColor(p.r, avg, c)).toArray(tint, i * 3);
	});

	const dots = pointCloud(pos, tint, alpha, 0.032, DOT_FRAG);
	scene.add(dots);

	// The hovered film, drawn larger and over everything.
	const hoverPos = new Float32Array(3);
	const hover = pointCloud(hoverPos, new Float32Array([0.957, 0.91, 0.82]), new Float32Array([1]), 0.06, DOT_FRAG);
	hover.material.depthTest = false;
	hover.renderOrder = 2;
	hover.visible = false;
	scene.add(hover);

	const labels = AXES.map(([text, at]) => {
		const el = document.createElement('span');
		el.className = 'taste__axis';
		el.textContent = text;
		stage.append(el);

		return { el, at: new THREE.Vector3(...at) };
	});

	let hovered = -1;
	const v = new THREE.Vector3();

	const render = () => {
		renderer.render(scene, camera);
		const { clientWidth: w, clientHeight: h } = stage;

		for (const l of labels) {
			v.copy(l.at).project(camera);
			l.el.style.left = `${((v.x + 1) / 2) * w}px`;
			l.el.style.top = `${((1 - v.y) / 2) * h}px`;
			l.el.hidden = v.z > 1;
		}

		if (hovered >= 0) {
			v.fromArray(points[hovered].p).project(camera);
			tip.style.left = `${((v.x + 1) / 2) * w}px`;
			tip.style.top = `${((1 - v.y) / 2) * h}px`;
		}
	};

	const resize = () => {
		const { clientWidth: w, clientHeight: h } = stage;
		renderer.setSize(w, h);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		// World-space point sizes → pixels at distance 1.
		const scale = (h * renderer.getPixelRatio()) / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));

		for (const o of [fog, dots, hover]) o.material.uniforms.uScale.value = scale;
		render();
	};

	new ResizeObserver(resize).observe(stage);
	controls.addEventListener('change', render);

	const raycaster = new THREE.Raycaster();
	const ndc = new THREE.Vector2();

	const pick = (e: PointerEvent): number => {
		const rect = renderer.domElement.getBoundingClientRect();
		ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
		raycaster.setFromCamera(ndc, camera);
		// Hit radius tracks zoom so a film is as easy to catch close up as far out.
		raycaster.params.Points.threshold = 0.012 * camera.position.distanceTo(controls.target);
		const hit = raycaster.intersectObject(dots)[0];

		return hit?.index ?? -1;
	};

	const show = (i: number) => {
		hovered = i;
		hover.visible = i >= 0;
		tip.hidden = i < 0;

		if (i >= 0) {
			const p = points[i];
			hoverPos.set(p.p);
			hover.geometry.attributes.position.needsUpdate = true;
			tip.href = `/films/movie/${p.t}`;
			tip.replaceChildren(p.n);

			if (p.y) {
				const y = document.createElement('span');
				y.className = 'taste__year';
				y.textContent = String(p.y);
				tip.append(y);
			}

			const s = document.createElement('span');
			s.className = 'taste__stars';
			s.textContent = starText(p.r) ?? 'unrated';
			tip.append(s);
		}

		renderer.domElement.style.cursor = i >= 0 ? 'pointer' : '';
		render();
	};

	let down: { x: number; y: number } | null = null;

	renderer.domElement.addEventListener('pointerdown', (e) => {
		down = { x: e.clientX, y: e.clientY };
	});

	renderer.domElement.addEventListener('pointermove', (e) => {
		if (e.pointerType !== 'mouse' || e.buttons) return;
		const i = pick(e);

		if (i !== hovered) show(i);
	});

	renderer.domElement.addEventListener('pointerleave', (e) => {
		if (e.pointerType === 'mouse' && !tip.matches(':hover')) show(-1);
	});

	// A click (not a drag) opens the film; a tap shows its card, which is the link.
	renderer.domElement.addEventListener('pointerup', (e) => {
		if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
		const i = pick(e);

		if (e.pointerType === 'mouse' && i >= 0) window.location.href = `/films/movie/${points[i].t}`;
		else show(i);
	});

	resize();
}
