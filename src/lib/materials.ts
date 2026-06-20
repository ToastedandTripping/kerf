import type { MaterialPreset } from "../app/types";

export const DEFAULT_MATERIALS: MaterialPreset[] = [
  // Plywood
  { id: "ply-3-cut", name: "Plywood 3mm Cut", material: "Plywood", thickness: "3mm", mode: "line", power: 90, powerMin: 0, speed: 600, passes: 1, airAssist: true, interval: 0.1 },
  { id: "ply-3-engrave", name: "Plywood 3mm Engrave", material: "Plywood", thickness: "3mm", mode: "fill", power: 40, powerMin: 10, speed: 12000, passes: 1, airAssist: false, interval: 0.1 },
  { id: "ply-6-cut", name: "Plywood 6mm Cut", material: "Plywood", thickness: "6mm", mode: "line", power: 100, powerMin: 0, speed: 300, passes: 2, airAssist: true, interval: 0.1 },

  // MDF
  { id: "mdf-3-cut", name: "MDF 3mm Cut", material: "MDF", thickness: "3mm", mode: "line", power: 95, powerMin: 0, speed: 480, passes: 1, airAssist: true, interval: 0.1 },
  { id: "mdf-3-engrave", name: "MDF 3mm Engrave", material: "MDF", thickness: "3mm", mode: "fill", power: 35, powerMin: 10, speed: 15000, passes: 1, airAssist: false, interval: 0.1 },

  // Acrylic
  { id: "acrylic-3-cut", name: "Acrylic 3mm Cut", material: "Acrylic", thickness: "3mm", mode: "line", power: 85, powerMin: 0, speed: 360, passes: 1, airAssist: true, interval: 0.1 },
  { id: "acrylic-3-engrave", name: "Acrylic 3mm Engrave", material: "Acrylic", thickness: "3mm", mode: "fill", power: 30, powerMin: 10, speed: 18000, passes: 1, airAssist: false, interval: 0.08 },
  { id: "acrylic-6-cut", name: "Acrylic 6mm Cut", material: "Acrylic", thickness: "6mm", mode: "line", power: 100, powerMin: 0, speed: 180, passes: 2, airAssist: true, interval: 0.1 },

  // Leather
  { id: "leather-2-cut", name: "Leather 2mm Cut", material: "Leather", thickness: "2mm", mode: "line", power: 60, powerMin: 0, speed: 900, passes: 1, airAssist: false, interval: 0.1 },
  { id: "leather-2-engrave", name: "Leather 2mm Engrave", material: "Leather", thickness: "2mm", mode: "fill", power: 25, powerMin: 5, speed: 18000, passes: 1, airAssist: false, interval: 0.08 },

  // Cardboard / Paper
  { id: "card-2-cut", name: "Cardboard 2mm Cut", material: "Cardboard", thickness: "2mm", mode: "line", power: 40, powerMin: 0, speed: 1200, passes: 1, airAssist: true, interval: 0.1 },
  { id: "paper-cut", name: "Paper Cut", material: "Paper", thickness: "0.1mm", mode: "line", power: 15, powerMin: 0, speed: 1800, passes: 1, airAssist: false, interval: 0.1 },

  // Fabric
  { id: "fabric-cut", name: "Fabric Cut", material: "Fabric", thickness: "1mm", mode: "line", power: 25, powerMin: 0, speed: 1500, passes: 1, airAssist: false, interval: 0.1 },

  // Cork
  { id: "cork-3-cut", name: "Cork 3mm Cut", material: "Cork", thickness: "3mm", mode: "line", power: 70, powerMin: 0, speed: 900, passes: 1, airAssist: true, interval: 0.1 },
  { id: "cork-3-engrave", name: "Cork 3mm Engrave", material: "Cork", thickness: "3mm", mode: "fill", power: 30, powerMin: 5, speed: 15000, passes: 1, airAssist: false, interval: 0.1 },

  // Anodized Aluminum
  { id: "anod-alum-engrave", name: "Anodized Aluminum Engrave", material: "Aluminum", thickness: "N/A", mode: "fill", power: 60, powerMin: 15, speed: 24000, passes: 1, airAssist: false, interval: 0.06 },

  // Slate / Stone
  { id: "slate-engrave", name: "Slate Engrave", material: "Slate", thickness: "5mm", mode: "fill", power: 80, powerMin: 20, speed: 9000, passes: 1, airAssist: false, interval: 0.08 },

  // Rubber Stamp
  { id: "rubber-stamp", name: "Rubber Stamp (deep)", material: "Rubber", thickness: "3mm", mode: "fill", power: 90, powerMin: 0, speed: 6000, passes: 3, airAssist: true, interval: 0.08 },
];
