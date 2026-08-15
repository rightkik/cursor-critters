/*!
 * cursor-critters v1.0.0 - procedural creatures that chase the mouse pointer
 * MIT License - Copyright (c) 2026 rightkik - https://www.PRESS.in.th
 *
 * Two creatures share one physics core:
 *   naga - a serpent dragon drawn as a glowing wireframe
 *   cat  - a small cat drawn as solid rounded shapes
 *
 * ==== Physics (shared by both creatures) ====
 *  - traction: acceleration is limited by how many feet are planted
 *      traction = 0.16 + (planted / total) * 0.84
 *    Lifting several feet at once means the body cannot accelerate, so a
 *    natural crouch-push-glide rhythm emerges without being animated by hand.
 *  - forward speed is momentum, not a direct assignment
 *  - turning has inertia: turn force accumulates, then decays exponentially
 *  - alignment: the body runs slower until it has turned to face the target
 *  - each joint eases toward its goal angle at a rate that falls off toward
 *    the tail, so a wave travels head-to-tail - this is what makes it flow
 *  - fixed timestep of 1/120s, so motion is identical on any frame rate
 *
 * ==== Switching creatures ====
 *  Call `window.cursorCritterSwitch()` from any button; it returns the new
 *  mode name. The choice is remembered in localStorage ('cursor-critter-mode').
 *  Default mode is 'cat'.
 *
 * ==== Rules this script always obeys ====
 *  1. Does nothing without a real pointing device - (hover:hover) and (pointer:fine)
 *  2. Does nothing when prefers-reduced-motion: reduce is set
 *  3. Fully stops when the tab is hidden or the canvas scrolls out of view
 *  4. Bails before allocating anything
 *  5. Expects pointer-events: none and aria-hidden on the canvas
 *  6. devicePixelRatio capped at 2, no shadowBlur
 */
(function () {
	'use strict';

	var canvas = document.getElementById('cursor-critter');
	if (!canvas || !canvas.getContext || !window.matchMedia || !window.requestAnimationFrame) { return; }
	if (!matchMedia('(hover: hover) and (pointer: fine)').matches) { return; }
	if (matchMedia('(prefers-reduced-motion: reduce)').matches) { return; }

	var ctx = canvas.getContext('2d', { alpha: false });
	if (!ctx) { return; }

	var TAU = Math.PI * 2;
	var STEP = 1 / 120, MAX_STEPS = 5;
	var OPT = window.CURSOR_CRITTER_OPTS || {};
	function opt(n, d) { return typeof OPT[n] === 'number' ? OPT[n] : d; }

	function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
	function angDiff(from, to) {
		var v = (to - from + Math.PI) % TAU;
		if (v < 0) { v += TAU; }
		return v - Math.PI;
	}
	function smoothstep(t) { return t * t * (3 - 2 * t); }

	/* ============================================================
	   Per-creature specification
	   ============================================================ */
	var SPEC = {
		naga: {
			seg: 46, link: 5.8, bend: 0.18, ease: 28, wave: 0.013, drive: 0.11,
			legAt: [0.13, 0.32], legReach: 32, legFore: [8, -10],
			bg: '#0a0805',
			segLen: function (i, L) {
				var knee = Math.round(SEG * 0.42);
				return i < knee ? L : Math.max(L * 0.42, L - (i - knee) * 0.16);
			},
			radius: function (i) {
				if (i < 2) { return 8.5 + i * 2.8; }
				if (i < 7) { return 11.3 + Math.sin(((i - 2) / 5) * Math.PI) * 4.8; }
				if (i < 15) { return 13.2 - (i - 7) * 0.32; }
				var t = (i - 15) / (SEG - 16);
				return Math.max(0.45, 10.6 * Math.pow(1 - t, 1.18));
			},
			draw: drawNaga
		},
		cat: {
			seg: 26, link: 6.2, bend: 0.26, ease: 33, wave: 0.022, drive: 0.13,
			legAt: [0.14, 0.30], legReach: 25, legFore: [6, -8],
			bg: '#141018',
			// a short stocky body (joints 0-7) followed by a long tapering tail
			segLen: function (i, L) { return i < 8 ? L : L * 0.74; },
			radius: function (i) {
				if (i <= 1) { return 12 + i * 3; }
				if (i <= 6) { return 15.5; }                       // torso
				if (i <= 8) { return 15.5 - (i - 6) * 4.5; }       // hips, 15.5 -> 6.5
				// tail: tapers along a smooth curve with no kink, ending genuinely thin
				var t = (i - 9) / Math.max(1, SEG - 10);           // 0..1
				return 5.8 * Math.pow(1 - t, 0.85) + 1.15;
			},
			draw: drawCat
		}
	};

	var MODE = 'cat';                                  // what a first-time visitor sees
	try { if (localStorage.getItem('cursor-critter-mode') === 'naga') { MODE = 'naga'; } } catch (e) {}
	if (OPT.creature === 'cat' || OPT.creature === 'naga') { MODE = OPT.creature; }

	/* ============================================================
	   State
	   ============================================================ */
	var SEG, LINK0, BEND, EASE, WAVE, DRIVE, LEGREACH, LEGFORE, BG, spec;
	var W = 0, H = 0, dpr = 1, S = 1;
	var bx = [], by = [], ba = [];
	var mouseX = 0, mouseY = 0, tx = 0, ty = 0;
	var headX = 0, headY = 0, heading = 0;
	var forwardSpeed = 0, turnSpeed = 0, movement = 0;
	var pointerSeen = -1e9, clock = 0, blink = 0;
	var running = false, visible = true, inView = true;
	var rafId = 0, lastTs = 0, acc = 0;
	var gaitPair = 0, legsReady = false;
	var legs = [], PAIRS = [[0, 3], [1, 2]];

	function applyMode(m) {
		spec = SPEC[m];
		SEG = Math.round(opt('seg', spec.seg));
		LINK0 = opt('link', spec.link);
		BEND = opt('bend', spec.bend);
		EASE = opt('ease', spec.ease);
		WAVE = opt('wave', spec.wave);
		DRIVE = opt('drive', spec.drive);
		LEGREACH = spec.legReach;
		LEGFORE = spec.legFore;
		BG = spec.bg;

		var a = Math.max(2, Math.round(SEG * spec.legAt[0]));
		var b = Math.max(a + 3, Math.round(SEG * spec.legAt[1]));
		legs = [
			{ at: a, side: -1 }, { at: a, side: 1 },
			{ at: b, side: -1 }, { at: b, side: 1 }
		];
		for (var k = 0; k < legs.length; k++) {
			var L = legs[k];
			L.fx = 0; L.fy = 0; L.ax = 0; L.ay = 0; L.tx2 = 0; L.ty2 = 0;
			L.t = 1; L.stepping = false;
		}
		bx.length = 0; by.length = 0; ba.length = 0;
		legsReady = false;
	}
	function segLen(i) { return spec.segLen(i, LINK0) * S; }
	function bodyR(i) { return spec.radius(i) * S; }

	function resize() {
		var rect = canvas.getBoundingClientRect();
		if (!rect.width || !rect.height) { return false; }
		dpr = Math.min(window.devicePixelRatio || 1, 2);
		W = rect.width; H = rect.height;
		canvas.width = Math.round(W * dpr);
		canvas.height = Math.round(H * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		S = clamp(Math.min(H / 320, W / 900), 0.6, 1.45);
		legsReady = false;
		return true;
	}

	function seed() {
		var cx = W * 0.5, cy = H * 0.55, i;
		headX = cx; headY = cy; heading = Math.PI;
		forwardSpeed = 0; turnSpeed = 0;
		for (i = 0; i < SEG; i++) { bx[i] = cx + i * segLen(i); by[i] = cy; ba[i] = 0; }
		tx = mouseX = cx; ty = mouseY = cy;
		legsReady = false;
	}

	var _tanX = 0, _tanY = 0, _norX = 0, _norY = 0;
	function frameAt(i) {
		var a = Math.max(0, i - 1), b = Math.min(SEG - 1, i + 1);
		var an = Math.atan2(by[a] - by[b], bx[a] - bx[b]);
		_tanX = Math.cos(an); _tanY = Math.sin(an);
		_norX = -_tanY; _norY = _tanX;
	}
	function goalX(L) { frameAt(L.at); return bx[L.at] + _norX * L.side * LEGREACH * S + _tanX * (L.at < SEG * 0.22 ? LEGFORE[0] : LEGFORE[1]) * S; }
	function goalY(L) { frameAt(L.at); return by[L.at] + _norY * L.side * LEGREACH * S + _tanY * (L.at < SEG * 0.22 ? LEGFORE[0] : LEGFORE[1]) * S; }

	/* ============================================================
	   Physics - shared by every creature
	   ============================================================ */
	function step(dt) {
		var i, k;
		clock += dt;

		if (clock - pointerSeen > 1.4) {
			var a = clock * 0.42;
			mouseX = W * (0.5 + 0.33 * Math.cos(a) * Math.cos(a * 0.43));
			mouseY = H * (0.5 + 0.28 * Math.sin(a * 1.29));
		}
		var kf = 1 - Math.exp(-30 * dt);
		tx += (mouseX - tx) * kf;
		ty += (mouseY - ty) * kf;

		var planted = 0;
		for (k = 0; k < legs.length; k++) { if (!legs[k].stepping) { planted++; } }
		var traction = 0.16 + (planted / legs.length) * 0.84;

		var dx = tx - headX, dy = ty - headY;
		var dist = Math.sqrt(dx * dx + dy * dy);
		var turnErr = angDiff(heading, Math.atan2(dy, dx));
		var alignment = clamp((Math.cos(turnErr) + 0.2) / 1.2, 0.12, 1);

		var maxVel = (170 + DRIVE * 1100) * S;
		var desired = Math.min(maxVel, Math.max(0, dist - 9 * S) * (2.5 + DRIVE * 8)) * (0.2 + alignment * 0.8);
		var accel = (3.4 + DRIVE * 13) * traction;
		forwardSpeed += (desired - forwardSpeed) * (1 - Math.exp(-accel * dt));

		var turnForce = (turnErr > 0 ? 1 : -1) * (5.5 + DRIVE * 34) *
			clamp(Math.abs(turnErr) / 0.72, 0, 1) * (0.45 + traction * 0.55);
		turnSpeed += turnForce * dt;
		turnSpeed *= Math.exp(-(4.6 + alignment * 1.8) * dt);
		var tcap = 2.6 + DRIVE * 7;
		turnSpeed = clamp(turnSpeed, -tcap, tcap);
		heading += turnSpeed * dt;

		headX += Math.cos(heading) * forwardSpeed * dt;
		headY += Math.sin(heading) * forwardSpeed * dt;
		headX = clamp(headX, 40 * S, W - 40 * S);
		headY = clamp(headY, 36 * S, H - 36 * S);
		movement = clamp(forwardSpeed / (620 * S), 0, 1);

		bx[0] = headX; by[0] = headY; ba[0] = heading + Math.PI;
		for (i = 1; i < SEG; i++) {
			var px = bx[i - 1], py = by[i - 1];
			var natural = Math.atan2(by[i] - py, bx[i] - px);
			var base = ba[i - 1];
			var maxJoint = i < 8 ? BEND : (BEND * 0.66 + i * 0.0025);
			var target = base + clamp(angDiff(base, natural), -maxJoint, maxJoint);
			var tailFactor = clamp((i - 8) / 20, 0, 1);
			target += Math.sin(clock * (5 + movement * 4) - i * 0.55) * movement * tailFactor * WAVE;
			var rate = Math.max(4, EASE - i * 0.38);
			ba[i] += angDiff(ba[i], target) * (1 - Math.exp(-rate * dt));
			var len = segLen(i);
			bx[i] = px + Math.cos(ba[i]) * len;
			by[i] = py + Math.sin(ba[i]) * len;
		}

		if (!legsReady) {
			for (k = 0; k < legs.length; k++) {
				legs[k].fx = goalX(legs[k]); legs[k].fy = goalY(legs[k]);
				legs[k].stepping = false; legs[k].t = 1;
			}
			legsReady = true;
		}

		var anyStepping = false;
		for (k = 0; k < legs.length; k++) { if (legs[k].stepping) { anyStepping = true; } }

		if (!anyStepping && movement > 0.025) {
			var err = [0, 0];
			for (var p = 0; p < 2; p++) {
				for (var q = 0; q < 2; q++) {
					var Lg = legs[PAIRS[p][q]];
					var ex = goalX(Lg) - Lg.fx, ey = goalY(Lg) - Lg.fy;
					var d2 = Math.sqrt(ex * ex + ey * ey);
					if (d2 > err[p]) { err[p] = d2; }
				}
			}
			var other = gaitPair === 0 ? 1 : 0;
			var pick = err[other] > err[gaitPair] + 3 * S ? other : gaitPair;
			if (err[pick] > (8.5 + movement * 1.5) * S) {
				for (var q2 = 0; q2 < 2; q2++) {
					var L2 = legs[PAIRS[pick][q2]];
					frameAt(L2.at);
					var lead = (7 + movement * 13) * S;
					L2.ax = L2.fx; L2.ay = L2.fy;
					L2.tx2 = goalX(L2) + _tanX * lead;
					L2.ty2 = goalY(L2) + _tanY * lead;
					L2.stepping = true; L2.t = 0;
				}
				gaitPair = pick === 0 ? 1 : 0;
			}
		}

		for (k = 0; k < legs.length; k++) {
			var L3 = legs[k];
			if (!L3.stepping) { continue; }
			frameAt(L3.at);
			L3.t = Math.min(1, L3.t + dt * (8.5 + movement * 9));
			var e = smoothstep(L3.t);
			var lift = Math.sin(L3.t * Math.PI) * 4.2 * S;
			L3.fx = L3.ax + (L3.tx2 - L3.ax) * e + _norX * lift * L3.side;
			L3.fy = L3.ay + (L3.ty2 - L3.ay) * e + _norY * lift * L3.side;
			if (L3.t >= 1) { L3.stepping = false; L3.fx = L3.tx2; L3.fy = L3.ty2; }
		}

		// blink roughly every 4 seconds (used by the cat)
		blink = (clock % 4.2 < 0.13) ? 1 : 0;
	}

	/* ============================================================
	   Drawing helpers
	   ============================================================ */
	function knee(ax, ay, fx, fy, side, at, up, lo) {
		var dx = fx - ax, dy = fy - ay;
		var raw = Math.sqrt(dx * dx + dy * dy) || 0.001;
		var d = clamp(raw, 8 * S, up + lo - 1);
		var ux = dx / raw, uy = dy / raw;
		var along = (up * up - lo * lo + d * d) / (2 * d);
		var rise = Math.sqrt(Math.max(0, up * up - along * along));
		var cx2 = ax + ux * along, cy2 = ay + uy * along;
		var A = { x: cx2 - uy * rise, y: cy2 + ux * rise };
		var B = { x: cx2 + uy * rise, y: cy2 - ux * rise };
		frameAt(at);
		var gx = ax + _norX * side * 13 * S, gy = ay + _norY * side * 13 * S;
		var dA = (A.x - gx) * (A.x - gx) + (A.y - gy) * (A.y - gy);
		var dB = (B.x - gx) * (B.x - gx) + (B.y - gy) * (B.y - gy);
		return dA < dB ? A : B;
	}

	function edgeArrays() {
		var lxs = [], lys = [], rxs = [], rys = [], i;
		for (i = 0; i < SEG; i++) {
			frameAt(i);
			var rr = bodyR(i);
			lxs.push(bx[i] + _norX * rr); lys.push(by[i] + _norY * rr);
			rxs.push(bx[i] - _norX * rr); rys.push(by[i] - _norY * rr);
		}
		return [lxs, lys, rxs, rys];
	}
	function tracePath(xs, ys, move) {
		if (move !== false) { ctx.moveTo(xs[0], ys[0]); }
		for (var j = 1; j < xs.length - 1; j++) {
			ctx.quadraticCurveTo(xs[j], ys[j], (xs[j] + xs[j + 1]) / 2, (ys[j] + ys[j + 1]) / 2);
		}
		ctx.lineTo(xs[xs.length - 1], ys[ys.length - 1]);
	}

	/* ============================================================
	   Creature 1 - naga, a serpent dragon
	   ============================================================ */
	var GOLD = 'rgba(255,205,105,', CORE = 'rgba(255,246,214,', JADE = 'rgba(120,224,176,';

	function kranok(x, y, size, side) {
		var ox = _norX * side, oy = _norY * side, bxk = -_tanX, byk = -_tanY;
		ctx.moveTo(x, y);
		ctx.quadraticCurveTo(x + ox * size * 1.15 + bxk * size * 0.25, y + oy * size * 1.15 + byk * size * 0.25,
			x + ox * size * 0.75 + bxk * size * 1.55, y + oy * size * 0.75 + byk * size * 1.55);
		ctx.quadraticCurveTo(x + ox * size * 0.30 + bxk * size * 1.75, y + oy * size * 0.30 + byk * size * 1.75,
			x + ox * size * 0.10 + bxk * size * 1.05, y + oy * size * 0.10 + byk * size * 1.05);
	}

	function drawNaga() {
		var i, k;
		for (var pass = 0; pass < 2; pass++) {
			ctx.strokeStyle = (pass ? CORE : GOLD) + (pass ? 0.95 : 0.16) + ')';
			ctx.lineWidth = (pass ? 1.2 : 5) * S;
			ctx.beginPath();
			for (k = 0; k < legs.length; k++) {
				var L = legs[k], at = L.at;
				frameAt(at);
				var sx = bx[at] + _norX * L.side * bodyR(at) * 0.8;
				var sy = by[at] + _norY * L.side * bodyR(at) * 0.8;
				var kn = knee(sx, sy, L.fx, L.fy, L.side, at, 22 * S, 25 * S);
				ctx.moveTo(sx, sy); ctx.lineTo(kn.x, kn.y); ctx.lineTo(L.fx, L.fy);
				if (pass) {
					var toe = Math.atan2(L.fy - kn.y, L.fx - kn.x);
					for (var t = -1.5; t <= 1.5; t++) {
						var ta = toe + t * 0.3;
						ctx.moveTo(L.fx, L.fy);
						ctx.quadraticCurveTo(L.fx + Math.cos(ta) * 7 * S, L.fy + Math.sin(ta) * 7 * S,
							L.fx + Math.cos(ta + 0.35) * 10 * S, L.fy + Math.sin(ta + 0.35) * 10 * S);
					}
				}
			}
			ctx.stroke();
		}

		ctx.strokeStyle = GOLD + '.72)';
		ctx.lineWidth = 1.15 * S;
		ctx.beginPath();
		for (i = 3; i < SEG - 3; i += 2) {
			frameAt(i);
			kranok(bx[i], by[i], bodyR(i) * 0.95 + 2.5 * S, (i % 4 === 3) ? 1 : -1);
		}
		ctx.stroke();

		ctx.strokeStyle = JADE + '.34)';
		ctx.lineWidth = 0.85 * S;
		ctx.beginPath();
		for (i = 3; i < SEG - 2; i++) {
			frameAt(i);
			var r2 = bodyR(i) * 0.9;
			var tipx = bx[i] + _tanX * r2 * 0.55, tipy = by[i] + _tanY * r2 * 0.55;
			ctx.moveTo(bx[i] + _norX * r2, by[i] + _norY * r2);
			ctx.quadraticCurveTo(bx[i] + _norX * r2 * 0.6 + _tanX * r2 * 0.45,
				by[i] + _norY * r2 * 0.6 + _tanY * r2 * 0.45, tipx, tipy);
			ctx.quadraticCurveTo(bx[i] - _norX * r2 * 0.6 + _tanX * r2 * 0.45,
				by[i] - _norY * r2 * 0.6 + _tanY * r2 * 0.45, bx[i] - _norX * r2, by[i] - _norY * r2);
		}
		ctx.stroke();

		var E = edgeArrays();
		for (var p2 = 0; p2 < 2; p2++) {
			ctx.strokeStyle = GOLD + (p2 ? 0.95 : 0.15) + ')';
			ctx.lineWidth = (p2 ? 1.3 : 6) * S;
			ctx.beginPath(); tracePath(E[0], E[1]); tracePath(E[2], E[3]); ctx.stroke();
		}

		ctx.strokeStyle = CORE + '.5)';
		ctx.lineWidth = 0.9 * S;
		ctx.beginPath();
		ctx.moveTo(bx[0], by[0]);
		for (i = 1; i < SEG - 1; i++) { ctx.quadraticCurveTo(bx[i], by[i], (bx[i] + bx[i + 1]) / 2, (by[i] + by[i + 1]) / 2); }
		ctx.lineTo(bx[SEG - 1], by[SEG - 1]);
		ctx.stroke();

		ctx.save();
		ctx.translate(bx[0], by[0]);
		ctx.rotate(heading);
		var u = S;
		ctx.strokeStyle = GOLD + '.95)';
		ctx.lineWidth = 1.35 * u;
		ctx.beginPath();
		ctx.moveTo(30 * u, 0);
		ctx.bezierCurveTo(20 * u, -7 * u, 8 * u, -13 * u, -10 * u, -12 * u);
		ctx.bezierCurveTo(-19 * u, -8 * u, -19 * u, 8 * u, -10 * u, 12 * u);
		ctx.bezierCurveTo(8 * u, 13 * u, 20 * u, 7 * u, 30 * u, 0);
		ctx.closePath(); ctx.stroke();
		ctx.beginPath();
		for (var ts = -1; ts <= 1; ts += 2) { ctx.moveTo(24 * u, ts * 4.5 * u); ctx.lineTo(28 * u, ts * 8 * u); }
		ctx.stroke();
		ctx.strokeStyle = CORE + '.9)';
		ctx.lineWidth = 1.15 * u;
		ctx.beginPath();
		for (var cs = -1; cs <= 1; cs++) {
			ctx.moveTo(-2 * u, cs * 6 * u);
			ctx.quadraticCurveTo(-9 * u, cs * 8 * u, -13 * u - Math.abs(cs) * 2 * u, cs * 5 * u);
		}
		ctx.stroke();
		ctx.strokeStyle = GOLD + '.85)';
		ctx.lineWidth = 1.25 * u;
		ctx.beginPath();
		for (var hs = -1; hs <= 1; hs += 2) {
			ctx.moveTo(-8 * u, hs * 11 * u);
			ctx.quadraticCurveTo(-26 * u, hs * 20 * u, -40 * u, hs * 13 * u);
			ctx.quadraticCurveTo(-33 * u, hs * 10 * u, -24 * u, hs * 12 * u);
		}
		ctx.stroke();
		ctx.strokeStyle = JADE + '.85)';
		ctx.lineWidth = 1.1 * u;
		var wob = Math.sin(clock * 3.1) * 3 * u * (0.4 + movement);
		ctx.beginPath();
		for (var ws = -1; ws <= 1; ws += 2) {
			ctx.moveTo(27 * u, ws * 5 * u);
			ctx.bezierCurveTo(40 * u, ws * 12 * u + wob, 46 * u, ws * 24 * u + wob, 36 * u, ws * 30 * u + wob);
			ctx.quadraticCurveTo(30 * u, ws * 31 * u + wob, 31 * u, ws * 24 * u + wob);
		}
		ctx.stroke();
		var look = clamp(angDiff(heading, Math.atan2(ty - by[0], tx - bx[0])), -0.6, 0.6);
		for (var es = -1; es <= 1; es += 2) {
			ctx.fillStyle = CORE + '.95)';
			ctx.beginPath(); ctx.ellipse(6 * u, es * 8 * u, 5 * u, 3.4 * u, es * 0.25, 0, TAU); ctx.fill();
			ctx.fillStyle = '#0a0805';
			ctx.beginPath();
			ctx.ellipse((6 + Math.cos(look) * 1.4) * u, (es * 8 + Math.sin(look) * 1.4) * u, 1.15 * u, 2.5 * u, look, 0, TAU);
			ctx.fill();
		}
		ctx.restore();
	}

	/* ============================================================
	   Creature 2 - cat
	   Drawn as solid rounded shapes rather than a wireframe skeleton
	   ============================================================ */
	var FUR = '#f0d5a2';        // main coat - cream yellow
	var FUR_DK = '#cfa259';     // tabby stripes and outlines
	var WHITE = '#fffaf0';      // white fur: chest, cheeks, paws, tail tip
	var PINK = '#ffb0bb';
	var AMBER = '#d59a3c';      // amber iris
	var DARK = '#2f2318';

	function drawCat() {
		var i, k;

		// ---- legs and paws (drawn first so the body covers their roots) ----
		ctx.strokeStyle = FUR_DK;
		ctx.lineCap = 'round';
		ctx.lineWidth = 7 * S;
		ctx.beginPath();
		for (k = 0; k < legs.length; k++) {
			var L = legs[k], at = L.at;
			frameAt(at);
			var sx = bx[at] + _norX * L.side * bodyR(at) * 0.65;
			var sy = by[at] + _norY * L.side * bodyR(at) * 0.65;
			var kn = knee(sx, sy, L.fx, L.fy, L.side, at, 15 * S, 17 * S);
			ctx.moveTo(sx, sy); ctx.lineTo(kn.x, kn.y); ctx.lineTo(L.fx, L.fy);
		}
		ctx.stroke();
		for (k = 0; k < legs.length; k++) {                     // round paws
			ctx.fillStyle = WHITE;
			ctx.beginPath(); ctx.arc(legs[k].fx, legs[k].fy, 5.2 * S, 0, TAU); ctx.fill();
		}

		// ---- body and tail: one filled shape with rounded edges ----
		var E = edgeArrays();
		ctx.beginPath();
		tracePath(E[0], E[1]);
		var rxs = E[2].slice().reverse(), rys = E[3].slice().reverse();
		ctx.lineTo(rxs[0], rys[0]);
		tracePath(rxs, rys, false);
		ctx.closePath();
		ctx.fillStyle = FUR;
		ctx.fill();
		ctx.strokeStyle = FUR_DK;
		ctx.lineWidth = 2 * S;
		ctx.stroke();

		// back stripes - thin curves, kept subtle so it does not read as a cartoon
		ctx.strokeStyle = FUR_DK;
		ctx.lineWidth = 2.2 * S;
		ctx.beginPath();
		for (i = 3; i <= 7; i += 2) {
			frameAt(i);
			var rr = bodyR(i) * 0.7;
			ctx.moveTo(bx[i] + _norX * rr, by[i] + _norY * rr);
			ctx.quadraticCurveTo(bx[i] - _tanX * rr * 0.55, by[i] - _tanY * rr * 0.55,
				bx[i] - _norX * rr, by[i] - _norY * rr);
		}
		ctx.stroke();

		// tail rings - thickness follows the real radius of each joint, so they
		// shrink along with the tail instead of staying a fixed width
		ctx.beginPath();
		for (i = 11; i < SEG - 4; i += 3) {
			frameAt(i);
			var rt = bodyR(i) * 0.95;
			ctx.lineWidth = Math.max(1, rt * 0.42);
			ctx.beginPath();
			ctx.moveTo(bx[i] + _norX * rt, by[i] + _norY * rt);
			ctx.lineTo(bx[i] - _norX * rt, by[i] - _norY * rt);
			ctx.stroke();
		}

		// white tail tip - painted over with a stroke as thick as the real radius,
		// which gives a naturally rounded end
		ctx.strokeStyle = WHITE;
		ctx.lineCap = 'round';
		for (i = SEG - 5; i < SEG - 1; i++) {
			ctx.lineWidth = bodyR(i) * 2;
			ctx.beginPath();
			ctx.moveTo(bx[i], by[i]);
			ctx.lineTo(bx[i + 1], by[i + 1]);
			ctx.stroke();
		}

		// ---- head ----
		ctx.save();
		ctx.translate(bx[0], by[0]);
		ctx.rotate(heading);
		var u = S, hr = 23 * u;

		// ears (drawn before the head so they sit behind its outline)
		ctx.fillStyle = FUR;
		ctx.strokeStyle = FUR_DK;
		ctx.lineWidth = 2 * u;
		for (var es2 = -1; es2 <= 1; es2 += 2) {
			ctx.beginPath();
			ctx.moveTo(-1 * u, es2 * 15 * u);
			ctx.lineTo(-16 * u, es2 * 27 * u);
			ctx.lineTo(-13 * u, es2 * 9 * u);
			ctx.closePath();
			ctx.fill(); ctx.stroke();
			ctx.fillStyle = PINK;                                  // inner ear
			ctx.beginPath();
			ctx.moveTo(-4 * u, es2 * 15 * u);
			ctx.lineTo(-14 * u, es2 * 23 * u);
			ctx.lineTo(-12 * u, es2 * 11 * u);
			ctx.closePath(); ctx.fill();
			ctx.fillStyle = FUR;
		}

		ctx.beginPath();
		ctx.arc(0, 0, hr, 0, TAU);
		ctx.fillStyle = FUR; ctx.fill();
		ctx.strokeStyle = FUR_DK; ctx.lineWidth = 2 * u; ctx.stroke();

		// white muzzle and cheeks
		ctx.fillStyle = WHITE;
		ctx.beginPath();
		ctx.ellipse(9 * u, 0, 9 * u, 11 * u, 0, 0, TAU);
		ctx.fill();

		// big round eyes, with a highlight and a blink
		var look = clamp(angDiff(heading, Math.atan2(ty - by[0], tx - bx[0])), -0.5, 0.5);
		var eh = blink ? 0.6 * u : 5.4 * u;
		for (var e2 = -1; e2 <= 1; e2 += 2) {
			ctx.fillStyle = AMBER;
			ctx.beginPath();
			ctx.ellipse(3 * u, e2 * 8.5 * u, 4.6 * u, eh, 0, 0, TAU);
			ctx.fill();
			if (!blink) {                                   // a cat pupil is a vertical slit
				ctx.fillStyle = DARK;
				ctx.beginPath();
				ctx.ellipse((3 + Math.cos(look) * 1.1) * u, (e2 * 8.5 + Math.sin(look) * 1.1) * u,
					1.5 * u, 4.2 * u, look, 0, TAU);
				ctx.fill();
			}
			if (!blink) {
				ctx.fillStyle = '#ffffff';
				ctx.beginPath();
				ctx.arc((4.4 + Math.cos(look) * 0.8) * u, (e2 * 8.5 - 1.6 + Math.sin(look) * 0.8) * u, 1.5 * u, 0, TAU);
				ctx.fill();
			}
		}

		// nose and mouth
		ctx.fillStyle = PINK;
		ctx.beginPath();
		ctx.moveTo(15 * u, 0);
		ctx.lineTo(11.5 * u, -2.6 * u);
		ctx.lineTo(11.5 * u, 2.6 * u);
		ctx.closePath(); ctx.fill();
		ctx.strokeStyle = DARK;
		ctx.lineWidth = 1.3 * u;
		ctx.beginPath();
		ctx.moveTo(13 * u, 0);
		ctx.quadraticCurveTo(11 * u, 3.4 * u, 8.5 * u, 2.2 * u);
		ctx.moveTo(13 * u, 0);
		ctx.quadraticCurveTo(11 * u, -3.4 * u, 8.5 * u, -2.2 * u);
		ctx.stroke();

		// whiskers
		ctx.strokeStyle = 'rgba(255,240,220,.85)';
		ctx.lineWidth = 1.1 * u;
		ctx.beginPath();
		for (var ws2 = -1; ws2 <= 1; ws2 += 2) {
			for (var n = -1; n <= 1; n++) {
				ctx.moveTo(12 * u, ws2 * 4 * u);
				ctx.quadraticCurveTo(20 * u, ws2 * (10 + n * 3) * u, 27 * u, ws2 * (9 + n * 6) * u);
			}
		}
		ctx.stroke();
		ctx.restore();
	}

	/* ============================================================
	   Draw and loop
	   ============================================================ */
	function draw() {
		ctx.fillStyle = BG;
		ctx.fillRect(0, 0, W, H);
		ctx.lineJoin = 'round';
		ctx.lineCap = 'round';
		spec.draw();
	}

	function frame(ts) {
		rafId = 0;
		if (!running) { return; }
		var dt = lastTs ? (ts - lastTs) / 1000 : STEP;
		lastTs = ts;
		acc += clamp(dt, 0, 0.25);
		var n = 0;
		while (acc >= STEP && n < MAX_STEPS) { step(STEP); acc -= STEP; n++; }
		if (n === MAX_STEPS) { acc = 0; }
		draw();
		rafId = requestAnimationFrame(frame);
	}
	function play() {
		if (running || !visible || !inView) { return; }
		running = true; lastTs = 0; acc = 0;
		if (!rafId) { rafId = requestAnimationFrame(frame); }
	}
	function pause() {
		running = false;
		if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
	}

	applyMode(MODE);
	if (!resize()) { return; }
	seed();

	var swapLabel = null;
	window.cursorCritterSwitch = function (to) {
		MODE = (to === 'cat' || to === 'naga') ? to : (MODE === 'cat' ? 'naga' : 'cat');
		try { localStorage.setItem('cursor-critter-mode', MODE); } catch (e) {}
		applyMode(MODE);
		resize();
		seed();
		draw();
		if (swapLabel) { swapLabel(); }
		return MODE;
	};
	window.cursorCritterMode = function () { return MODE; };

	// ---- switch button: wired up here if the page provides one ----
	// Done inside the script rather than with an inline handler, so that when
	// the script bails the button stays inert and is hidden by the same CSS.
	var swap = document.getElementById('cursor-critter-swap');
	if (swap) {
		swapLabel = function () {
			// The label names the creature you WILL get if you press it,
			// not the one currently on screen - the usual toggle convention.
			swap.textContent = MODE === 'cat' ? 'Reptile' : 'Cat';
			swap.setAttribute('aria-label', swap.textContent);
		};
		swapLabel();
		swap.addEventListener('click', function () { window.cursorCritterSwitch(); });
	}

	window.addEventListener('pointermove', function (e) {
		var rect = canvas.getBoundingClientRect();
		mouseX = clamp(e.clientX - rect.left, 20, rect.width - 20);
		mouseY = clamp(e.clientY - rect.top, 18, rect.height - 18);
		pointerSeen = clock;
	}, { passive: true });

	var rt;
	window.addEventListener('resize', function () {
		clearTimeout(rt);
		rt = setTimeout(function () { if (resize()) { seed(); } }, 150);
	}, { passive: true });

	document.addEventListener('visibilitychange', function () {
		visible = !document.hidden;
		if (visible) { play(); } else { pause(); }
	});

	if (window.IntersectionObserver) {
		new IntersectionObserver(function (en) {
			inView = en[0].isIntersecting;
			if (inView) { play(); } else { pause(); }
		}, { threshold: 0 }).observe(canvas);
	}

	if (window.CURSOR_CRITTER_DEBUG) {
		window.__critter = { step: step, draw: draw, STEP: STEP, mode: function () { return MODE; },
			state: function () {
				var planted = 0;
				for (var i = 0; i < legs.length; i++) { if (!legs[i].stepping) { planted++; } }
				return { forwardSpeed: forwardSpeed, turnSpeed: turnSpeed, movement: movement, planted: planted, mode: MODE };
			} };
	}

	play();
}());
