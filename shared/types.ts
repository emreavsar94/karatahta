export interface Nokta {
  x: number;
  y: number;
}

export interface Stroke {
  id: string;
  renk: number;      // 0xRRGGBB biçiminde
  kalinlik: number;  // tahta birimi cinsinden
  noktalar: Nokta[];
}