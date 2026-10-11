import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { Nokta, Stroke } from "../shared/types";

const app = document.querySelector<HTMLDivElement>("#app")!;

const TAHTA_G = 1600;
const TAHTA_Y = 900;
const MIN_ARALIK = 3;      // iki nokta arasındaki en küçük mesafe (tahta birimi)
const SILGI_YARICAP = 20;  // silgi halkasının yarıçapı (tahta birimi)

// --- Sahne, kamera, renderer ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1f1c);

const kamera = new THREE.OrthographicCamera(0, TAHTA_G, TAHTA_Y, 0, -1, 1);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
const tuval = renderer.domElement;
tuval.style.touchAction = "none"; // dokunmatikte sayfa kaymasın
app.appendChild(tuval);

// --- Durum ---
type Arac = "kalem" | "silgi";
type Aksiyon =
  | { tip: "ekle"; stroke: Stroke }
  | { tip: "sil"; strokeler: Stroke[] };

let arac: Arac = "kalem";
let seciliRenk = 0xffffff;
let seciliKalinlik = 6;

const cizimler: Stroke[] = [];             // tahtadaki çizgilerin verisi
const cizgiler = new Map<string, Line2>(); // id -> ekrandaki çizgi
let aktif: Stroke | null = null;           // kalemle şu an çizilen
let aktifCizgi: Line2 | null = null;
let silinen: Stroke[] | null = null;       // silgiyle bu sürüklemede silinenler

const geriYigini: Aksiyon[] = [];
const ileriYigini: Aksiyon[] = [];

// --- Malzemeler (renk + kalınlık çiftine bir tane) ---
interface MalzemeKaydi {
  malzeme: LineMaterial;
  kalinlik: number;
}
const malzemeler = new Map<string, MalzemeKaydi>();
let olcek = 1; // 1 tahta birimi kaç ekran pikseli

function malzemeAl(renk: number, kalinlik: number): LineMaterial {
  const anahtar = `${renk}:${kalinlik}`;
  let kayit = malzemeler.get(anahtar);
  if (!kayit) {
    kayit = {
      malzeme: new LineMaterial({ color: renk, linewidth: kalinlik * olcek }),
      kalinlik,
    };
    malzemeler.set(anahtar, kayit);
  }
  return kayit.malzeme;
}

function boyutla() {
  olcek = Math.min(window.innerWidth / TAHTA_G, window.innerHeight / TAHTA_Y);
  renderer.setSize(TAHTA_G * olcek, TAHTA_Y * olcek);
  for (const m of malzemeler.values()) m.malzeme.linewidth = m.kalinlik * olcek;
}
boyutla();
window.addEventListener("resize", boyutla);

// --- Silgi halkası (sadece silgi seçiliyken görünür) ---
const halka = new THREE.Mesh(
  new THREE.RingGeometry(SILGI_YARICAP - 2, SILGI_YARICAP, 40),
  new THREE.MeshBasicMaterial({ color: 0xffffff }),
);
halka.visible = false;
scene.add(halka);

// --- Koordinat dönüşümü ---
function tahtaKonumu(e: PointerEvent): Nokta {
  const kutu = tuval.getBoundingClientRect();
  return {
    x: ((e.clientX - kutu.left) / kutu.width) * TAHTA_G,
    y: TAHTA_Y - ((e.clientY - kutu.top) / kutu.height) * TAHTA_Y,
  };
}

// --- Stroke (veri) -> Line2 (görüntü) ---
function geometriYap(stroke: Stroke): LineGeometry {
  const duz: number[] = [];
  for (const n of stroke.noktalar) duz.push(n.x, n.y, 0);
  if (stroke.noktalar.length === 1) {
    const n = stroke.noktalar[0];
    duz.push(n.x + 0.01, n.y, 0);
  }
  return new LineGeometry().setPositions(duz);
}

function cizgiOlustur(stroke: Stroke): Line2 {
  const cizgi = new Line2(geometriYap(stroke), malzemeAl(stroke.renk, stroke.kalinlik));
  scene.add(cizgi);
  cizgiler.set(stroke.id, cizgi);
  return cizgi;
}

function cizgiyiGuncelle(cizgi: Line2, stroke: Stroke) {
  cizgi.geometry.dispose(); // eski geometrinin GPU belleğini boşalt
  cizgi.geometry = geometriYap(stroke);
}

// --- Tahtaya çizgi ekleme / çıkarma (ağdan gelen çizgiler de bunları kullanacak) ---
function strokeEkle(stroke: Stroke) {
  cizimler.push(stroke);
  cizgiOlustur(stroke);
}

function strokeSil(id: string): Stroke | undefined {
  const i = cizimler.findIndex((s) => s.id === id);
  if (i === -1) return undefined;
  const [stroke] = cizimler.splice(i, 1);
  const cizgi = cizgiler.get(id);
  if (cizgi) {
    scene.remove(cizgi);
    cizgi.geometry.dispose();
    cizgiler.delete(id);
  }
  return stroke;
}

// --- Silgi: bir noktaya yeterince yakın çizgi var mı? ---
function segmenteUzaklik(p: Nokta, a: Nokta, b: Nokta): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const uzunlukKare = dx * dx + dy * dy;
  if (uzunlukKare === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  // p'nin a-b doğrusu üzerindeki izdüşümü (0 = a, 1 = b), parçanın dışına taşmasın
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / uzunlukKare;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function strokeVurdu(stroke: Stroke, p: Nokta): boolean {
  const esik = SILGI_YARICAP + stroke.kalinlik / 2;
  const n = stroke.noktalar;
  if (n.length === 1) return Math.hypot(p.x - n[0].x, p.y - n[0].y) <= esik;
  for (let i = 1; i < n.length; i++) {
    if (segmenteUzaklik(p, n[i - 1], n[i]) <= esik) return true;
  }
  return false;
}

function silgiUygula(p: Nokta, liste: Stroke[]) {
  for (const s of [...cizimler]) { // kopya üzerinde dolaş, çünkü dizi değişiyor
    if (strokeVurdu(s, p)) {
      strokeSil(s.id);
      liste.push(s);
    }
  }
}

// --- Geri / ileri ---
const geriDugme = document.querySelector<HTMLButtonElement>("#geri")!;
const ileriDugme = document.querySelector<HTMLButtonElement>("#ileri")!;
const tumunuSilDugme = document.querySelector<HTMLButtonElement>("#tumunu-sil")!;

function dugmeleriGuncelle() {
  geriDugme.disabled = geriYigini.length === 0;
  ileriDugme.disabled = ileriYigini.length === 0;
  tumunuSilDugme.disabled = cizimler.length === 0;
}

function kaydet(aksiyon: Aksiyon) {
  geriYigini.push(aksiyon);
  ileriYigini.length = 0; // yeni işlem yapılınca "ileri" geçmişi geçersiz olur
  dugmeleriGuncelle();
}

function geriAl() {
  if (aktif || silinen) return; // çizim/silme sürerken geri alma
  const a = geriYigini.pop();
  if (!a) return;
  if (a.tip === "ekle") strokeSil(a.stroke.id);
  else a.strokeler.forEach((s) => strokeEkle(s));
  ileriYigini.push(a);
  dugmeleriGuncelle();
}

function yinele() {
  if (aktif || silinen) return;
  const a = ileriYigini.pop();
  if (!a) return;
  if (a.tip === "ekle") strokeEkle(a.stroke);
  else a.strokeler.forEach((s) => strokeSil(s.id));
  geriYigini.push(a);
  dugmeleriGuncelle();
}

function tumunuSil() {
  if (aktif || silinen || cizimler.length === 0) return;
  const hepsi = [...cizimler];
  hepsi.forEach((s) => strokeSil(s.id));
  kaydet({ tip: "sil", strokeler: hepsi });
}

// --- Fare olayları ---
tuval.addEventListener("pointerdown", (e) => {
  tuval.setPointerCapture(e.pointerId);
  const p = tahtaKonumu(e);
  if (arac === "kalem") {
    aktif = {
      id: crypto.randomUUID(),
      renk: seciliRenk,
      kalinlik: seciliKalinlik,
      noktalar: [p],
    };
    aktifCizgi = cizgiOlustur(aktif);
  } else {
    silinen = [];
    silgiUygula(p, silinen);
  }
});

tuval.addEventListener("pointermove", (e) => {
  const p = tahtaKonumu(e);
  halka.visible = arac === "silgi";
  halka.position.set(p.x, p.y, 0.5);

  if (aktif && aktifCizgi) {
    const son = aktif.noktalar[aktif.noktalar.length - 1];
    if (Math.hypot(p.x - son.x, p.y - son.y) < MIN_ARALIK) return;
    aktif.noktalar.push(p);
    cizgiyiGuncelle(aktifCizgi, aktif);
  } else if (silinen) {
    silgiUygula(p, silinen);
  }
});

tuval.addEventListener("pointerleave", () => {
  halka.visible = false;
});

function bitir() {
  if (aktif) {
    cizimler.push(aktif);
    kaydet({ tip: "ekle", stroke: aktif });
    console.log("Biten çizgi:", JSON.stringify(aktif));
  } else if (silinen && silinen.length > 0) {
    kaydet({ tip: "sil", strokeler: silinen });
  }
  aktif = null;
  aktifCizgi = null;
  silinen = null;
}
tuval.addEventListener("pointerup", bitir);
tuval.addEventListener("pointercancel", bitir);

// --- Klavye: Ctrl+Z geri, Ctrl+Y veya Ctrl+Shift+Z ileri ---
window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const tus = e.key.toLowerCase();
  if (tus === "z" && !e.shiftKey) {
    e.preventDefault();
    geriAl();
  } else if (tus === "y" || (tus === "z" && e.shiftKey)) {
    e.preventDefault();
    yinele();
  }
});

// --- Araç çubuğu ---
const aracDugmeleri = document.querySelectorAll<HTMLButtonElement>("[data-arac]");
const renkDugmeleri = document.querySelectorAll<HTMLButtonElement>(".renk");
const kalinlikDugmeleri = document.querySelectorAll<HTMLButtonElement>("[data-kalinlik]");

function aracSec(yeni: Arac) {
  arac = yeni;
  aracDugmeleri.forEach((d) => d.classList.toggle("secili", d.dataset.arac === yeni));
  tuval.style.cursor = yeni === "silgi" ? "none" : "crosshair";
  if (yeni === "kalem") halka.visible = false;
}

function renkSec(dugme: HTMLButtonElement) {
  seciliRenk = parseInt(dugme.dataset.renk!, 16);
  renkDugmeleri.forEach((d) => d.classList.toggle("secili", d === dugme));
  aracSec("kalem"); // renk seçince kaleme dön
}

function kalinlikSec(dugme: HTMLButtonElement) {
  seciliKalinlik = Number(dugme.dataset.kalinlik);
  kalinlikDugmeleri.forEach((d) => d.classList.toggle("secili", d === dugme));
  aracSec("kalem");
}

aracDugmeleri.forEach((d) => d.addEventListener("click", () => aracSec(d.dataset.arac as Arac)));
renkDugmeleri.forEach((d) => {
  d.style.background = "#" + d.dataset.renk;
  d.addEventListener("click", () => renkSec(d));
});
kalinlikDugmeleri.forEach((d) => d.addEventListener("click", () => kalinlikSec(d)));

geriDugme.addEventListener("click", geriAl);
ileriDugme.addEventListener("click", yinele);
tumunuSilDugme.addEventListener("click", tumunuSil);

// Başlangıç seçimleri
renkSec(renkDugmeleri[0]);
kalinlikSec(kalinlikDugmeleri[1]); // Orta
dugmeleriGuncelle();

renderer.setAnimationLoop(() => renderer.render(scene, kamera));