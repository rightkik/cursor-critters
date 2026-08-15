/*!
 * cursor-critters v1.0.0 - procedural creatures that chase the mouse pointer
 * MIT License - Copyright (c) 2026 rightkik - https://www.PRESS.in.th
 *
 * Two creatures share one physics core:
 *   naga - a Thai temple serpent: emerald scales, gold crest, open red mouth
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
			seg: 52, link: 5.4, bend: 0.18, ease: 28, wave: 0.013, drive: 0.11,
			legAt: [0.13, 0.32], legReach: 32, legFore: [8, -10],
			// A naga is a serpent, so its legs are never drawn. They are still
			// simulated: the gait is what feeds traction, and traction is what
			// gives the body its push-and-glide rhythm. Take the legs out of the
			// physics and the creature turns into a smoothly gliding noodle.
			showLegs: false,
			bg: '#07130d',
			segLen: function (i, L) {
				var knee = Math.round(SEG * 0.42);
				return i < knee ? L : Math.max(L * 0.42, L - (i - knee) * 0.16);
			},
			radius: function (i) {
				if (i < 2) { return 11 + i * 3.4; }
				if (i < 7) { return 14.8 + Math.sin(((i - 2) / 5) * Math.PI) * 5.6; }
				if (i < 15) { return 17.2 - (i - 7) * 0.36; }
				// the tail stays a body rather than thinning to a needle - it
				// finishes in a carved gold flame instead of a point
				var t = (i - 15) / (SEG - 16);
				return Math.max(2.8, 14.8 * Math.pow(1 - t, 1.05));
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
	/* Painted the way the thing is actually carved and gilded: emerald body,
	   gold crest and trim, pale belly banding, red mouth. Colour turns out to
	   carry more of the recognition than any single shape does. */
	var N_BODY = '#0e7a45';       // emerald body
	var N_BODY_LT = '#17995a';    // lit green, used on the skull
	var N_SCALE = '#0a5730';      // scale shadow
	var N_GOLD = '#f2c74e';
	var N_GOLD_DK = '#a8760d';
	var N_WHITE = '#eef6f0';
	var N_RED = '#b81f2b';

	/* The crest: a fan of gold flame points sweeping back from the skull. On a
	   carved naga this is the tallest thing on the animal, and seen from above
	   it is the shape that separates a naga from any other serpent. It widens
	   with speed and leans out of a turn. */
	/* The tail does not taper away to a needle - it finishes in a carved gold
	   flame, the same as the crest, which bookends the animal. */
	function drawTailFan() {
		var i = SEG - 1;
		frameAt(i);
		var cx = bx[i], cy = by[i];
		var wag = Math.sin(clock * 2.4) * 0.25 * (0.3 + movement);
		ctx.fillStyle = N_GOLD;
		ctx.strokeStyle = N_GOLD_DK;
		ctx.lineWidth = 0.9 * S;
		for (var f = -1; f <= 1; f++) {
			var sp = f * 0.62 + wag;
			var dx = -_tanX * Math.cos(sp) + _norX * Math.sin(sp);
			var dy = -_tanY * Math.cos(sp) + _norY * Math.sin(sp);
			var nx = -dy, ny = dx;
			var len = (16 - Math.abs(f) * 5) * S;
			ctx.beginPath();
			ctx.moveTo(cx, cy);
			ctx.quadraticCurveTo(cx + dx * len * 0.6 + nx * 5 * S, cy + dy * len * 0.6 + ny * 5 * S,
				cx + dx * len, cy + dy * len);
			ctx.quadraticCurveTo(cx + dx * len * 0.55 - nx * 4 * S, cy + dy * len * 0.55 - ny * 4 * S,
				cx, cy);
			ctx.closePath();
			ctx.fill();
			ctx.stroke();
		}
	}

	function drawNaga() {
		var i;
		var E = edgeArrays();

		drawTailFan();

		if (spec.showLegs) {
			for (var pass = 0; pass < 2; pass++) {
				ctx.strokeStyle = (pass ? '#fff6d6' : 'rgba(242,199,78,.2)');
				ctx.lineWidth = (pass ? 1.2 : 5) * S;
				ctx.beginPath();
				for (var k = 0; k < legs.length; k++) {
					var L = legs[k], at = L.at;
					frameAt(at);
					var sx = bx[at] + _norX * L.side * bodyR(at) * 0.8;
					var sy = by[at] + _norY * L.side * bodyR(at) * 0.8;
					var kn = knee(sx, sy, L.fx, L.fy, L.side, at, 22 * S, 25 * S);
					ctx.moveTo(sx, sy); ctx.lineTo(kn.x, kn.y); ctx.lineTo(L.fx, L.fy);
				}
				ctx.stroke();
			}
		}

		// ---- body: solid emerald, the way the thing is actually painted ----
		ctx.beginPath();
		tracePath(E[0], E[1]);
		var rxs = E[2].slice().reverse(), rys = E[3].slice().reverse();
		ctx.lineTo(rxs[0], rys[0]);
		tracePath(rxs, rys, false);
		ctx.closePath();
		ctx.fillStyle = N_BODY;
		ctx.fill();

		/* The pale belly banding that runs the length of a carved naga, right on
		   the edge where the green turns over. Two strokes, white outside gold. */
		ctx.lineWidth = 2.6 * S;
		ctx.strokeStyle = N_WHITE;
		ctx.beginPath(); tracePath(E[0], E[1]); tracePath(E[2], E[3]); ctx.stroke();
		ctx.lineWidth = 1.1 * S;
		ctx.strokeStyle = N_GOLD;
		ctx.beginPath(); tracePath(E[0], E[1]); tracePath(E[2], E[3]); ctx.stroke();

		// ---- scales ----
		ctx.strokeStyle = N_SCALE;
		ctx.lineWidth = 0.8 * S;
		ctx.beginPath();
		for (i = 3; i < SEG - 3; i += 2) {
			frameAt(i);
			var r = bodyR(i);
			for (var q = 1; q <= 2; q++) {
				var w2 = r * (q === 1 ? 0.42 : 0.8);
				ctx.moveTo(bx[i] + _norX * w2, by[i] + _norY * w2);
				ctx.quadraticCurveTo(bx[i] - _tanX * r * 0.6, by[i] - _tanY * r * 0.6,
					bx[i] - _norX * w2, by[i] - _norY * w2);
			}
		}
		ctx.stroke();

		/* The dorsal ridge: a row of gold spikes down the spine. On the statue
		   they stand up along the back, so from above they sit right on the
		   centre line - which makes this the cheapest strong naga cue we have. */
		ctx.fillStyle = N_GOLD;
		for (i = 5; i < SEG - 4; i += 2) {
			frameAt(i);
			var sr = bodyR(i) * 0.1 + 0.7 * S;
			var tip = bodyR(i) * 0.2 + 2.2 * S;
			ctx.beginPath();
			ctx.moveTo(bx[i] + _tanX * tip, by[i] + _tanY * tip);
			ctx.lineTo(bx[i] + _norX * sr, by[i] + _norY * sr);
			ctx.lineTo(bx[i] - _norX * sr, by[i] - _norY * sr);
			ctx.closePath();
			ctx.fill();
		}

		/* Ornamental collar, the gold band cinched around the body behind the
		   head on every temple naga. */
		var cat2 = Math.min(8, SEG - 1);
		frameAt(cat2);
		var cr = bodyR(cat2) * 1.12;
		ctx.strokeStyle = N_GOLD;
		ctx.lineWidth = 4.5 * S;
		ctx.beginPath();
		ctx.moveTo(bx[cat2] + _norX * cr, by[cat2] + _norY * cr);
		ctx.lineTo(bx[cat2] - _norX * cr, by[cat2] - _norY * cr);
		ctx.stroke();
		ctx.strokeStyle = N_WHITE;
		ctx.lineWidth = 1.4 * S;
		ctx.stroke();

		// ================= head =================
		ctx.save();
		ctx.translate(bx[0], by[0]);
		ctx.rotate(heading);
		/* The head is deliberately oversized against the body. On the carvings
		   it is the whole point of the animal, and at this scale a head drawn
		   to realistic proportion just disappears. */
		var u = S * 1.3;

		/* Crest, drawn here in head coordinates rather than out on the body:
		   anywhere else and the skull is painted over the top of it. Seven
		   flame petals raked backward, longest in the middle. */
		var grow = 0.92 + movement * 0.3;
		ctx.strokeStyle = N_GOLD_DK;
		ctx.lineWidth = 1 * u;
		for (var cside = -1; cside <= 1; cside += 2) {
			for (var cf = 0; cf < 3; cf++) {
				var cang = cside * (2.56 + cf * 0.28);
				var clen = (34 + (cf === 1 ? 14 : 0)) * u * grow;
				var cdx = Math.cos(cang), cdy = Math.sin(cang);
				var cnx = -cdy, cny = cdx, cw = 5.4 * u;
				ctx.beginPath();
				ctx.moveTo(cnx * cw * 0.3, cny * cw * 0.3);
				ctx.quadraticCurveTo(cdx * clen * 0.6 + cnx * cw, cdy * clen * 0.6 + cny * cw,
					cdx * clen, cdy * clen);
				ctx.quadraticCurveTo(cdx * clen * 0.6 - cnx * cw, cdy * clen * 0.6 - cny * cw,
					-cnx * cw * 0.3, -cny * cw * 0.3);
				ctx.closePath();
				ctx.fillStyle = N_GOLD;
				ctx.fill();
				ctx.stroke();
			}
		}

		// skull
		ctx.beginPath();
		ctx.moveTo(40 * u, 0);
		ctx.bezierCurveTo(33 * u, -6.5 * u, 16 * u, -13 * u, -8 * u, -12.5 * u);
		ctx.bezierCurveTo(-19 * u, -9 * u, -19 * u, 9 * u, -8 * u, 12.5 * u);
		ctx.bezierCurveTo(16 * u, 13 * u, 33 * u, 6.5 * u, 40 * u, 0);
		ctx.closePath();
		ctx.fillStyle = N_BODY_LT;
		ctx.fill();
		ctx.strokeStyle = N_GOLD;
		ctx.lineWidth = 1.5 * u;
		ctx.stroke();

		/* The open mouth. A naga is nearly always carved mid-roar, and from
		   above that is a red wedge splitting the snout. */
		var gape = 1 + Math.sin(clock * 1.7) * 0.12;
		ctx.fillStyle = N_RED;
		ctx.beginPath();
		ctx.moveTo(9 * u, 0);
		ctx.quadraticCurveTo(24 * u, -5 * u * gape, 36 * u, -6.5 * u * gape);
		ctx.quadraticCurveTo(38 * u, 0, 36 * u, 6.5 * u * gape);
		ctx.quadraticCurveTo(24 * u, 5 * u * gape, 9 * u, 0);
		ctx.closePath();
		ctx.fill();
		ctx.strokeStyle = N_GOLD;
		ctx.lineWidth = 1.2 * u;
		ctx.stroke();

		// forked tongue, flicking out of the open mouth
		var flick = clock % 2.7;
		if (flick < 0.5) {
			var reach = 13 * u * Math.sin((flick / 0.5) * Math.PI);
			ctx.strokeStyle = '#ff5a68';
			ctx.lineWidth = 1.5 * u;
			ctx.beginPath();
			ctx.moveTo(34 * u, 0);
			ctx.lineTo(34 * u + reach, 0);
			ctx.moveTo(34 * u + reach, 0);
			ctx.lineTo(34 * u + reach + 5 * u, -3.6 * u);
			ctx.moveTo(34 * u + reach, 0);
			ctx.lineTo(34 * u + reach + 5 * u, 3.6 * u);
			ctx.stroke();
		}

		// fangs
		ctx.fillStyle = N_WHITE;
		for (var fg = -1; fg <= 1; fg += 2) {
			ctx.beginPath();
			ctx.moveTo(33 * u, fg * 5.6 * u * gape);
			ctx.lineTo(28 * u, fg * 2 * u * gape);
			ctx.lineTo(26 * u, fg * 5.8 * u * gape);
			ctx.closePath();
			ctx.fill();
		}

		/* Gold scrollwork over the brow. Two curls per side is enough to suggest
		   carving without turning into noise at this size. */
		ctx.strokeStyle = N_GOLD;
		ctx.lineWidth = 1.3 * u;
		ctx.beginPath();
		for (var cs = -1; cs <= 1; cs += 2) {
			ctx.moveTo(2 * u, cs * 11 * u);
			ctx.quadraticCurveTo(-8 * u, cs * 14 * u, -13 * u, cs * 7 * u);
			ctx.moveTo(8 * u, cs * 8 * u);
			ctx.quadraticCurveTo(2 * u, cs * 13 * u, -3 * u, cs * 9 * u);
		}
		ctx.stroke();

		/* Chin barbels, swept back along the body. Pointing them forward makes
		   them read as insect antennae, the one silhouette a naga must not have. */
		ctx.strokeStyle = N_GOLD;
		ctx.lineWidth = 1.2 * u;
		var wob = Math.sin(clock * 3.1) * 3.5 * u * (0.4 + movement);
		ctx.beginPath();
		for (var ws = -1; ws <= 1; ws += 2) {
			// One open sweep each, trailing back past the skull. Curling them round
			// into a closed loop turns the pair into a ring that reads as a collar
			// worn on the head, which is not what a barbel is.
			ctx.moveTo(18 * u, ws * 9 * u);
			ctx.bezierCurveTo(2 * u, ws * 21 * u + wob, -26 * u, ws * 27 * u + wob,
				-52 * u, ws * 19 * u + wob);
		}
		ctx.stroke();

		// eyes, tracking the pointer
		var look = clamp(angDiff(heading, Math.atan2(ty - by[0], tx - bx[0])), -0.6, 0.6);
		for (var es = -1; es <= 1; es += 2) {
			ctx.fillStyle = N_GOLD;
			ctx.beginPath();
			ctx.ellipse(4 * u, es * 8 * u, 6 * u, 4.2 * u, es * 0.25, 0, TAU);
			ctx.fill();
			ctx.fillStyle = N_WHITE;
			ctx.beginPath();
			ctx.ellipse(4 * u, es * 8 * u, 4.2 * u, 2.8 * u, es * 0.25, 0, TAU);
			ctx.fill();
			ctx.fillStyle = '#05281a';
			ctx.beginPath();
			ctx.ellipse((4 + Math.cos(look) * 1.6) * u, (es * 8 + Math.sin(look) * 1.6) * u,
				1.3 * u, 2.4 * u, look, 0, TAU);
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
