import type { RaceContext, RaceController, ThemeModule } from '../types';
import { buildCrowdStrip, renderPattern, drawEntryList, VW, VH } from '../sideRace';
import { SILKS_COLORS } from '../palette';
import { HORSE_FRAME_A, HORSE_FRAME_B } from './sprites';

const BODY_COLORS = ['#8a5a2b', '#6b4423', '#a9743c', '#4a3320', '#96672e', '#7d5634'];

// ---- コース形状: スタート直後の直線(ホームストレッチ)→向正面コーナー→バックストレッチ
// →最終コーナー→ホームストレッチでゴール(斜め俯瞰)。
// 「直線→カーブ→直線→カーブ→直線→ゴール」の5区間になる ----
const STRAIGHT_LEN = 1600;
const BACK_Y = 260; // バックストレッチ(奥側)のワールドY
const HOME_Y = 620; // ホームストレッチ(手前側)のワールドY
const TURN_CX = STRAIGHT_LEN;
const TURN_CY = (BACK_Y + HOME_Y) / 2;
const TURN_R = (HOME_Y - BACK_Y) / 2;
const TURN_ARC_LEN = Math.PI * TURN_R;
const LOOP_LEN = STRAIGHT_LEN * 2 + TURN_ARC_LEN * 2; // 向正面コーナー〜ホームストレッチ1周分
const LEAD_IN = STRAIGHT_LEN; // スタート直後の直線(ホームストレッチを1本通過してから1周する)
const TRACK_LEN = LEAD_IN + LOOP_LEN;
const BAND_HALF = 78; // レーン帯の半幅

interface TrackPos {
  x: number;
  y: number;
  /** 進行方向(0=右向き 〜 π=左向き) */
  heading: number;
  /** コース内側方向の単位法線 */
  nx: number;
  ny: number;
}

/** 向正面コーナー→バックストレッチ→最終コーナー→ホームストレッチの1周分(距離0..LOOP_LEN) */
function loopPointAt(cs: number): TrackPos {
  // 向正面コーナー(ホームストレッチ端→バックストレッチ端へ抜ける)
  if (cs <= TURN_ARC_LEN) {
    const t = cs / TURN_R; // 0..π
    const angle = Math.PI / 2 + t;
    return {
      x: TURN_R * Math.cos(angle),
      y: TURN_CY + TURN_R * Math.sin(angle),
      heading: Math.PI - t,
      nx: -Math.cos(angle),
      ny: -Math.sin(angle),
    };
  }

  // バックストレッチ
  if (cs <= TURN_ARC_LEN + STRAIGHT_LEN) {
    return { x: cs - TURN_ARC_LEN, y: BACK_Y, heading: 0, nx: 0, ny: 1 };
  }

  // 最終コーナー
  if (cs <= TURN_ARC_LEN * 2 + STRAIGHT_LEN) {
    const t = (cs - TURN_ARC_LEN - STRAIGHT_LEN) / TURN_R; // 0..π
    const angle = -Math.PI / 2 + t;
    return {
      x: TURN_CX + TURN_R * Math.cos(angle),
      y: TURN_CY + TURN_R * Math.sin(angle),
      heading: t,
      nx: -Math.cos(angle),
      ny: -Math.sin(angle),
    };
  }

  // ホームストレッチ(ゴールへ)
  const u = cs - TURN_ARC_LEN * 2 - STRAIGHT_LEN;
  return { x: STRAIGHT_LEN - u, y: HOME_Y, heading: Math.PI, nx: 0, ny: -1 };
}

/** コース上の距離sから位置・向き・法線を求める */
function trackPointAt(s: number): TrackPos {
  const cs = Math.min(TRACK_LEN, Math.max(0, s));

  // スタート直後の直線(ホームストレッチを向正面コーナーへ向けて1本通過)
  if (cs <= LEAD_IN) {
    return { x: STRAIGHT_LEN - cs, y: HOME_Y, heading: Math.PI, nx: 0, ny: -1 };
  }

  return loopPointAt(cs - LEAD_IN);
}

type Phase = 'intro' | 'race' | 'photo' | 'announce' | 'done';

const INTRO_SEC = 3.4;
const SLOWMO_WINDOW = 1.1;
const SLOWMO_SCALE = 0.42;

/** 競馬専用: オーバル調のコースをカーブ込みで描くレースエンジン */
class KeibaOvalRace {
  private ctx2d: CanvasRenderingContext2D;
  private sprites: Array<[HTMLCanvasElement, HTMLCanvasElement]>;
  private crowdStrip = buildCrowdStrip();
  private raf = 0;
  private lastTs = 0;
  private phase: Phase = 'intro';
  private phaseClock = 0;
  private raceClock = 0;
  private firedEvents = new Set<number>();
  private telopTimer: number | null = null;
  private resolveFinished!: () => void;
  finished: Promise<void>;
  /** 馬ごとのコース内外への揺れ(内側に切れ込む・外に膨らむ)のパラメータ */
  private sway: Array<{ amp: number; omega: number; phase: number }>;

  constructor(private c: RaceContext) {
    this.ctx2d = c.canvas.getContext('2d')!;
    this.sprites = c.names.map((_, i) => this.buildSprites(i));
    this.sway = c.names.map(() => ({
      amp: 0.5 + Math.random() * 1.1,
      omega: 0.45 + Math.random() * 0.75,
      phase: Math.random() * Math.PI * 2,
    }));
    this.finished = new Promise((res) => (this.resolveFinished = res));
  }

  private buildSprites(index: number): [HTMLCanvasElement, HTMLCanvasElement] {
    const silks = SILKS_COLORS[index % SILKS_COLORS.length];
    const palette: Record<string, string> = {
      b: BODY_COLORS[index % BODY_COLORS.length],
      d: '#332313',
      j: silks,
      h: silks === '#f5f5f5' ? '#cc3333' : silks,
      s: '#e8b88a',
      w: '#f5f0e8',
    };
    return [renderPattern(HORSE_FRAME_A, palette), renderPattern(HORSE_FRAME_B, palette)];
  }

  start(): void {
    this.c.audio.fanfare();
    this.lastTs = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  skip(): void {
    if (this.phase === 'done') return;
    this.setPhase('done');
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    if (this.telopTimer !== null) clearTimeout(this.telopTimer);
    this.c.audio.stopAll();
  }

  // ---------- 進行 ----------

  private setPhase(p: Phase): void {
    this.phase = p;
    this.phaseClock = 0;
    const { audio, script, names } = this.c;
    if (p === 'race') {
      audio.startBgm('keiba');
      audio.ambientStart('gallop');
    }
    if (p === 'photo') {
      audio.ambientStop();
      audio.stopBgm();
      this.telop('写真判定中・・・');
      audio.drumroll(2.6);
    }
    if (p === 'announce') {
      audio.ambientStop();
      audio.stopBgm();
      this.telop(`1着 ${names[script.winnerIndex]}!!`);
    }
    if (p === 'done') {
      this.stop();
      this.c.onTelop(null);
      this.resolveFinished();
    }
  }

  private telop(text: string, hideAfter = 2.4): void {
    this.c.onTelop(text);
    if (this.telopTimer !== null) clearTimeout(this.telopTimer);
    this.telopTimer = window.setTimeout(() => this.c.onTelop(null), hideAfter * 1000);
  }

  private loop = (ts: number): void => {
    const dt = Math.min(0.05, (ts - this.lastTs) / 1000);
    this.lastTs = ts;
    this.update(dt);
    this.draw();
    if (this.phase !== 'done') this.raf = requestAnimationFrame(this.loop);
  };

  private update(dt: number): void {
    const { script } = this.c;
    this.phaseClock += dt;

    switch (this.phase) {
      case 'intro':
        if (this.phaseClock >= INTRO_SEC) this.setPhase('race');
        break;

      case 'race': {
        const remain = script.duration - this.raceClock;
        const scale = remain > 0 && remain < SLOWMO_WINDOW ? SLOWMO_SCALE : 1;
        this.raceClock += dt * scale;

        for (const ev of script.events) {
          if (this.raceClock >= ev.time && !this.firedEvents.has(ev.time)) {
            this.firedEvents.add(ev.time);
            this.telop(ev.text);
            if (ev.sfx === 'start') this.c.audio.startSignal();
            if (ev.sfx === 'bell') this.c.audio.bell();
            if (ev.sfx === 'crowd') this.c.audio.crowd(4);
          }
        }

        if (this.raceClock >= script.duration + 0.8) {
          this.setPhase(script.photoFinish ? 'photo' : 'announce');
        }
        break;
      }

      case 'photo':
        this.raceClock += dt * 0.3;
        if (this.phaseClock >= 2.8) this.setPhase('announce');
        break;

      case 'announce':
        this.raceClock += dt * 0.3;
        if (this.phaseClock >= 1.6) this.setPhase('done');
        break;
    }
  }

  /** 0(スタート)〜1(ゴール)の進捗 */
  private progress(i: number): number {
    const t = this.phase === 'intro' ? 0 : this.raceClock;
    return this.c.script.racers[i].progressAt(t);
  }

  // ---------- 描画 ----------

  private draw(): void {
    const { canvas } = this.c;
    const g = this.ctx2d;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth * dpr;
    const ch = canvas.clientHeight * dpr;
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#000';
    g.fillRect(0, 0, cw, ch);
    const s = Math.min(cw / VW, ch / VH);
    g.setTransform(s, 0, 0, s, (cw - VW * s) / 2, (ch - VH * s) / 2);
    g.imageSmoothingEnabled = false;

    this.drawWorld(g);
    if (this.phase === 'intro') drawEntryList(g, this.c.names, '出 走 表');
    if (this.phase === 'photo') this.drawPhotoFlash(g);
  }

  private drawWorld(g: CanvasRenderingContext2D): void {
    const n = this.c.names.length;

    // 先頭の位置を画面中心付近に据えるカメラ(進行方向に応じて見せ幅を前方寄りにする)。
    // ZOOMを上げるほど寄りの画になる。ズームに合わせて縦方向も先頭を追う
    const ZOOM = 1.55;
    let leaderS = 0;
    for (let i = 0; i < n; i++) leaderS = Math.max(leaderS, this.progress(i) * TRACK_LEN);
    const lp = trackPointAt(leaderS);
    const bias = 170; // ワールド単位での前方バイアス
    const camCX = lp.x + Math.cos(lp.heading) * bias;
    const camCY = lp.y;

    this.drawScenery(g, camCX);

    g.save();
    g.translate(VW / 2, VH / 2);
    g.scale(ZOOM, ZOOM);
    g.translate(-camCX, -camCY);

    this.drawCourse(g, 0);

    const laneStep = (BAND_HALF * 2) / n; // スプライトの大きさ基準(従来通り)

    // 内側(+側)へ寄せて詰めた基準位置。全員がなるべくインコースを走ろうとする形にする
    const innerEdge = BAND_HALF - 4;
    const outerEdge = -BAND_HALF * 0.1;
    const packStep = (innerEdge - outerEdge) / n;

    // スタート直後は必ず横一列(ゲート幅いっぱいに等間隔)に並べ、
    // そこからインコース寄り+横揺れへ数秒かけて自然に移行する
    const gateOffset = (i: number) => -BAND_HALF + laneStep * i + laneStep / 2;
    const RAMP_SEC = 2.5;
    const rampT = Math.max(0, Math.min(1, this.raceClock / RAMP_SEC));

    // 奥(小さいY)から手前(大きいY)へ描画して奥行きを表現
    const order = this.c.names
      .map((_, i) => i)
      .sort((a, b) => trackPointAt(this.progress(a) * TRACK_LEN).y - trackPointAt(this.progress(b) * TRACK_LEN).y);

    for (const i of order) {
      const p = trackPointAt(this.progress(i) * TRACK_LEN);
      const baseOffset = outerEdge + packStep * i + packStep / 2;
      const sw = this.sway[i];
      const sway = Math.sin(this.raceClock * sw.omega + sw.phase) * sw.amp * packStep;
      const racingOffset = Math.max(-BAND_HALF + 2, Math.min(BAND_HALF - 2, baseOffset + sway));
      const offset = gateOffset(i) + (racingOffset - gateOffset(i)) * rampT;
      const x = p.x + p.nx * offset;
      const y = p.y + p.ny * offset;

      const depth = (p.y - BACK_Y) / (HOME_Y - BACK_Y); // 0(奥)〜1(手前)
      const depthScale = 0.82 + depth * 0.36;

      const frame = Math.floor((this.raceClock * 9 + i * 1.3) % 2);
      const spr = this.sprites[i][this.phase === 'intro' ? 0 : frame];
      const spriteScale = Math.min(3.2, Math.max(0.28, (laneStep * 0.95) / spr.height)) * depthScale;
      const w = spr.width * spriteScale;
      const h = spr.height * spriteScale;
      const flip = Math.cos(p.heading) < 0;

      g.save();
      g.translate(x, y);
      if (flip) g.scale(-1, 1);
      g.drawImage(spr, -w / 2, -h / 2, w, h);
      g.restore();

      // 名前ラベル
      const fontSize = Math.min(17, Math.max(8, spriteScale * 5.2));
      const labelH = fontSize + 4;
      g.font = `bold ${fontSize}px sans-serif`;
      const label = this.c.names[i];
      const tw = g.measureText(label).width;
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(x - tw / 2 - 4, y - h / 2 - labelH - 1, tw + 8, labelH);
      g.fillStyle = SILKS_COLORS[i % SILKS_COLORS.length];
      g.fillRect(x - tw / 2 - 4, y - h / 2 - labelH - 1, 3, labelH);
      g.fillStyle = '#fff';
      g.textBaseline = 'top';
      g.fillText(label, x - tw / 2 + 1, y - h / 2 - labelH + 1);
    }

    g.restore();

    this.drawMiniMap(g);
    if (this.phase !== 'intro') this.drawRanking(g);
  }

  private drawScenery(g: CanvasRenderingContext2D, camX: number): void {
    const sky = g.createLinearGradient(0, 0, 0, 150);
    sky.addColorStop(0, '#7ec8e8');
    sky.addColorStop(1, '#cfe9f5');
    g.fillStyle = sky;
    g.fillRect(0, 0, VW, 150);

    const crowdShift = (camX * 0.3) % 640;
    for (let x = -crowdShift - 640; x < VW + 640; x += 640) {
      g.drawImage(this.crowdStrip, x, 108, 640, 36);
    }
    g.fillStyle = '#8a8a9e';
    g.fillRect(0, 150, VW, 8);
    // ズームでコースが上下に振れても黒い隙間が出ないよう下地を敷いておく
    g.fillStyle = '#2f7a33';
    g.fillRect(0, 158, VW, VH - 158);
  }

  private drawCourse(g: CanvasRenderingContext2D, camX: number): void {
    const surface = '#3f9c40';
    const rail = '#f2f2f2';
    const outerHalf = BAND_HALF + 10;
    const innerR = TURN_R - outerHalf;
    const outerR = TURN_R + outerHalf;

    // 内馬場(コース内側の芝生)。両コーナーを繋いだ閉じたオーバル形状にする
    g.beginPath();
    g.moveTo(0 - camX, BACK_Y + outerHalf);
    g.lineTo(TURN_CX - camX, BACK_Y + outerHalf);
    g.arc(TURN_CX - camX, TURN_CY, innerR, -Math.PI / 2, Math.PI / 2);
    g.lineTo(0 - camX, HOME_Y - outerHalf);
    g.arc(0 - camX, TURN_CY, innerR, Math.PI / 2, (Math.PI * 3) / 2);
    g.closePath();
    g.fillStyle = '#2f7a33';
    g.fill();

    // バックストレッチ / ホームストレッチ
    g.fillStyle = surface;
    g.fillRect(0 - camX, BACK_Y - outerHalf, STRAIGHT_LEN, outerHalf * 2);
    g.fillRect(0 - camX, HOME_Y - outerHalf, STRAIGHT_LEN, outerHalf * 2);

    // 最終コーナー・向正面コーナー(太い円弧)
    g.save();
    g.translate(-camX, 0);
    [TURN_CX, 0].forEach((cx, idx) => {
      g.beginPath();
      const start = idx === 0 ? -Math.PI / 2 : Math.PI / 2;
      const end = idx === 0 ? Math.PI / 2 : (Math.PI * 3) / 2;
      g.arc(cx, TURN_CY, TURN_R, start, end);
      g.lineWidth = outerHalf * 2;
      g.strokeStyle = surface;
      g.stroke();
    });
    g.restore();

    // 柵(内側・外側)
    g.strokeStyle = rail;
    g.lineWidth = 4;
    const railStraight = (y: number) => {
      g.beginPath();
      g.moveTo(0 - camX, y);
      g.lineTo(TURN_CX - camX, y);
      g.stroke();
    };
    railStraight(BACK_Y - outerHalf);
    railStraight(BACK_Y + outerHalf);
    railStraight(HOME_Y - outerHalf);
    railStraight(HOME_Y + outerHalf);
    g.save();
    g.translate(-camX, 0);
    [innerR, outerR].forEach((r) => {
      g.beginPath();
      g.arc(TURN_CX, TURN_CY, r, -Math.PI / 2, Math.PI / 2);
      g.stroke();
      g.beginPath();
      g.arc(0, TURN_CY, r, Math.PI / 2, (Math.PI * 3) / 2);
      g.stroke();
    });
    g.restore();

    // スタート(ホームストレッチのもう一方の端)とゴール
    this.drawGate(g, STRAIGHT_LEN - camX, HOME_Y, outerHalf);
    this.drawGoal(g, 0 - camX, HOME_Y, outerHalf);
  }

  private drawGate(g: CanvasRenderingContext2D, x: number, y: number, half: number): void {
    if (x < -80 || x > VW + 80) return;
    g.fillStyle = '#cccccc';
    g.fillRect(x - 4, y - half - 14, 8, half * 2 + 28);
    g.fillStyle = '#888';
    g.fillRect(x - 10, y - half - 26, 20, 14);
  }

  private drawGoal(g: CanvasRenderingContext2D, x: number, y: number, half: number): void {
    if (x < -80 || x > VW + 80) return;
    g.fillStyle = '#cc2222';
    for (let yy = y - half - 14; yy < y + half + 14; yy += 16) {
      g.fillRect(x - 4, yy, 8, 8);
    }
    g.fillStyle = '#f5f5f5';
    for (let yy = y - half - 6; yy < y + half + 14; yy += 16) {
      g.fillRect(x - 4, yy, 8, 8);
    }
    g.fillStyle = '#222';
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 6; c++) {
        if ((r + c) % 2 === 0) g.fillRect(x - 46 + c * 12, y - half - 90 + r * 12, 12, 12);
      }
    }
    g.fillStyle = '#fff';
    g.font = 'bold 20px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillText('GOAL', x, y - half - 96);
    g.textAlign = 'start';
  }

  private drawMiniMap(g: CanvasRenderingContext2D): void {
    const mx = VW * 0.2;
    const mw = VW * 0.6;
    const my = 28;
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(mx - 10, my - 12, mw + 20, 26);
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(mx, my);
    g.lineTo(mx + mw, my);
    g.stroke();
    g.fillStyle = '#ffb300';
    g.fillRect(mx + mw - 2, my - 8, 4, 16);
    const dotR = this.c.names.length > 30 ? 3 : 5;
    this.c.names.forEach((_, i) => {
      g.fillStyle = SILKS_COLORS[i % SILKS_COLORS.length];
      const px = mx + this.progress(i) * mw;
      g.beginPath();
      g.arc(px, my, dotR, 0, Math.PI * 2);
      g.fill();
    });
  }

  private drawRanking(g: CanvasRenderingContext2D): void {
    const { racers } = this.c.script;
    const order = this.c.names
      .map((_, i) => i)
      .sort((a, b) => this.progress(b) - this.progress(a) || racers[a].finishTime - racers[b].finishTime)
      .slice(0, 3);
    g.font = 'bold 18px sans-serif';
    g.textBaseline = 'top';
    order.forEach((idx, rank) => {
      const y = 60 + rank * 26;
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(14, y, 190, 23);
      g.fillStyle = SILKS_COLORS[idx % SILKS_COLORS.length];
      g.fillRect(14, y, 5, 23);
      g.fillStyle = rank === 0 ? '#ffd54a' : '#fff';
      g.fillText(`${rank + 1}位 ${this.c.names[idx]}`, 26, y + 3);
    });
  }

  private drawPhotoFlash(g: CanvasRenderingContext2D): void {
    const a = Math.max(0, 0.85 - this.phaseClock * 1.5);
    if (a > 0) {
      g.fillStyle = `rgba(255,255,255,${a})`;
      g.fillRect(0, 0, VW, VH);
    }
  }
}

export const keibaTheme: ThemeModule = {
  id: 'keiba',
  name: '競馬',
  icon: '🏇',
  maxLanes: 100,
  available: true,
  // 実際の最終コーナー(向正面コーナーの次、ホームストレッチ手前)でテロップが出るように合わせる
  cornerAt: (LEAD_IN + TURN_ARC_LEN + STRAIGHT_LEN + TURN_ARC_LEN / 2) / TRACK_LEN,
  run(ctx: RaceContext): RaceController {
    const race = new KeibaOvalRace(ctx);
    race.start();
    return { finished: race.finished, skip: () => race.skip(), stop: () => race.stop() };
  },
};
