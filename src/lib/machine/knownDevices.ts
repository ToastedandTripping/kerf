interface KnownDevice {
  vid: number;
  pid: number;
  label: string;
}

const KNOWN_LASER_DEVICES: KnownDevice[] = [
  { vid: 0x1a86, pid: 0x7523, label: "CH340 (GRBL)" },
  { vid: 0x1a86, pid: 0x5523, label: "CH341 (GRBL)" },
  { vid: 0x0403, pid: 0x6001, label: "FTDI FT232R" },
  { vid: 0x0403, pid: 0x6014, label: "FTDI FT232H" },
  { vid: 0x10c4, pid: 0xea60, label: "CP2102 (SiLabs)" },
  { vid: 0x2341, pid: 0x0043, label: "Arduino Uno" },
  { vid: 0x2341, pid: 0x0042, label: "Arduino Mega" },
  { vid: 0x0483, pid: 0x5740, label: "STM32 VCP" },
];

function isKnownLaserDevice(vid: number | null, pid: number | null): KnownDevice | undefined {
  if (vid === null || pid === null) return undefined;
  return KNOWN_LASER_DEVICES.find((d) => d.vid === vid && d.pid === pid);
}

export function sortPortsByPriority<
  T extends { vid: number | null; pid: number | null; name: string },
>(ports: T[]): T[] {
  return [...ports].sort((a, b) => {
    const aKnown = isKnownLaserDevice(a.vid, a.pid);
    const bKnown = isKnownLaserDevice(b.vid, b.pid);
    if (aKnown && !bKnown) return -1;
    if (!aKnown && bKnown) return 1;
    const aUsb = a.name.includes("ttyUSB") || a.name.includes("ttyACM") || a.name.includes("COM");
    const bUsb = b.name.includes("ttyUSB") || b.name.includes("ttyACM") || b.name.includes("COM");
    if (aUsb && !bUsb) return -1;
    if (!aUsb && bUsb) return 1;
    return a.name.localeCompare(b.name);
  });
}
